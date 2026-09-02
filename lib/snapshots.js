/**
 * Kidai Plugin Remote — snapshots.js
 *
 * Shared, boot-safe snapshot store at `$DSH_HOME/.kidai-snapshots/<id>/`,
 * readable by BOTH the external manager (KPR) and an in-DSH guard plugin:
 *
 *   <id>/
 *     snapshot.json          metadata (status: pending|verified|failed|rolled-back)
 *     profile.package.json   profile manifest copy
 *     cordis.patch.yml.home  home patch layer copy
 *     cordis.patch.yml.profile profile patch layer copy
 *     plugin-management.json desktop private disabled-bundle state copy
 *     packages/<name>/       third-party package dirs (offline rollback)
 *
 * Lifecycle: every config mutation (toggle/mount/uninstall/remove) and every
 * DSH launch takes a PENDING snapshot of the state it is about to leave. When
 * the next DSH boot is healthy (the guard plugin marks it, or KPR detects the
 * desktop health-commit), pending snapshots become VERIFIED. If a launch
 * fails, its snapshot is marked FAILED and KPR offers rollback to the last
 * verified snapshot — restoring manifest, patch layers, desktop state AND the
 * third-party package dirs, so a bad plugin update is fully reversible.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homePatchPath, backupFile, backupDirectory, setEnabledRow } from "./patches.js";
import { resolveProfileDir, readPluginManagement } from "./dsh-env.js";
import { readProfileManifest } from "./profile.js";

export const SNAPSHOT_DIR_NAME = ".kidai-snapshots";
export const SNAPSHOT_VERSION = 1;
const CORE_NAMES = new Set(["@deepseek-ai/dsh-base", "dsh-plugin-desktop", "dsh-community-market"]);

export function snapshotsRoot(home) {
  return join(home, SNAPSHOT_DIR_NAME);
}

export function snapshotDir(home, id) {
  return join(snapshotsRoot(home), id);
}

export function newSnapshotId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safePackageRel(name) {
  return String(name).split("/").join("__");
}

/** Read one snapshot's metadata (undefined when absent/unreadable). */
export function readSnapshotMeta(home, id) {
  try {
    const parsed = JSON.parse(readFileSync(join(snapshotDir(home, id), "snapshot.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Update a snapshot's human note (used to tell snapshots apart). */
export function setSnapshotNote(home, id, note) {
  if (typeof id !== "string" || id.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(id)) {
    return { ok: false, message: "无效的快照 id" };
  }
  const metaPath = join(snapshotDir(home, id), "snapshot.json");
  if (!existsSync(metaPath)) {
    return { ok: false, message: "快照不存在" };
  }
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const next = typeof note === "string" ? note.trim() : "";
    if (next.length > 200) return { ok: false, message: "备注过长（最多 200 字）" };
    meta.note = next;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return { ok: true, id, note: next };
  } catch (error) {
    return { ok: false, message: `备注写入失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Create a PENDING snapshot of the state a mutation/launch is about to leave.
 * Copies the profile manifest, home/profile patch layers, desktop
 * plugin-management state, and every third-party package dir (for offline
 * rollback of bad updates).
 * @returns the snapshot metadata.
 */
export function createSnapshot(env, profileName, composed, { trigger = "manual", note = "" } = {}) {
  const profileDir = composed?.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const id = newSnapshotId();
  const dir = snapshotDir(env.dshHome, id);
  mkdirSync(dir, { recursive: true });
  const files = {};

  const manifestPath = join(profileDir, "package.json");
  if (existsSync(manifestPath)) {
    copyFileSync(manifestPath, join(dir, "profile.package.json"));
    files.profileManifest = "profile.package.json";
  }
  const homePatch = homePatchPath(env.dshHome);
  if (existsSync(homePatch)) {
    copyFileSync(homePatch, join(dir, "cordis.patch.yml.home"));
    files.homePatch = "cordis.patch.yml.home";
  }
  const profilePatch = join(profileDir, "cordis.patch.yml");
  if (existsSync(profilePatch)) {
    copyFileSync(profilePatch, join(dir, "cordis.patch.yml.profile"));
    files.profilePatch = "cordis.patch.yml.profile";
  }
  const pm = readPluginManagement(env.userData);
  if (pm?.path !== undefined && existsSync(pm.path)) {
    copyFileSync(pm.path, join(dir, "plugin-management.json"));
    files.pluginManagement = "plugin-management.json";
  }

  const packages = {};
  const manifest = readProfileManifest(profileDir);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith("@deepseek-ai/") || CORE_NAMES.has(name)) continue;
    const pkgDir = join(profileDir, "node_modules", ...name.split("/"));
    if (!existsSync(pkgDir)) continue;
    const rel = safePackageRel(name);
    const dest = join(dir, "packages", rel);
    try {
      cpSync(pkgDir, dest, { recursive: true });
      packages[name] = rel;
    } catch {
      /* a package copy failure must not abort the snapshot */
    }
  }

  const meta = {
    id,
    version: SNAPSHOT_VERSION,
    profile: profileName,
    createdAt: new Date().toISOString(),
    trigger,
    note,
    status: "pending",
    files,
    packages,
  };
  writeFileSync(join(dir, "snapshot.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** List snapshots for a profile, newest first. */
export function listSnapshots(env, profileName) {
  const root = snapshotsRoot(env.dshHome);
  const result = [];
  try {
    if (!existsSync(root)) return result;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = readSnapshotMeta(env.dshHome, entry.name);
      if (meta === undefined) continue;
      if (meta.profile !== undefined && meta.profile !== profileName) continue;
      let size = 0;
      try {
        size = dirSize(snapshotDir(env.dshHome, entry.name));
      } catch {
        /* ignore */
      }
      result.push({ ...meta, size });
    }
  } catch {
    /* unreadable */
  }
  result.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return result;
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Update a snapshot's status (pending → verified / failed / rolled-back). */
export function setSnapshotStatus(home, id, status) {
  const meta = readSnapshotMeta(home, id);
  if (meta === undefined) return false;
  meta.status = status;
  if (status === "verified") meta.verifiedAt = new Date().toISOString();
  if (status === "failed") meta.failedAt = new Date().toISOString();
  try {
    writeFileSync(join(snapshotDir(home, id), "snapshot.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile pending snapshots after a boot: when the desktop's last boot was
 * healthy (selection active == lastKnownGood), every pending snapshot is
 * VERIFIED ("kept until the next successful run", then promoted).
 */
export function reconcilePendingSnapshots(env, profileName) {
  const selection = readSelection(env);
  if (selection === undefined || selection.active !== selection.lastKnownGood) return { verified: 0 };
  if (env.desktopRunning) return { verified: 0, running: true };
  let verified = 0;
  for (const snap of listSnapshots(env, profileName)) {
    if (snap.status === "pending" && setSnapshotStatus(env.dshHome, snap.id, "verified")) verified += 1;
  }
  return { verified };
}

function readSelection(env) {
  try {
    const parsed = JSON.parse(readFileSync(env.selectionStatePath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && typeof parsed.active === "string") {
      return {
        active: parsed.active,
        lastKnownGood: typeof parsed.lastKnownGood === "string" ? parsed.lastKnownGood : parsed.active,
      };
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/**
 * Roll back to one snapshot: restore the profile manifest, home/profile patch
 * layers, desktop plugin-management state and third-party package dirs. A
 * PRE-ROLLBACK snapshot of the current state is taken first so the rollback
 * itself is reversible. Returns the result; a DSH restart is required.
 * @param disableSuspected - also write `disabled: true` rows for plugins that
 * appeared/changed AFTER the snapshot (the likely crash culprits), so the
 * restored state boots without them.
 */
export async function rollbackSnapshot(env, profileName, composed, id, { disableSuspected = false } = {}) {
  const meta = readSnapshotMeta(env.dshHome, id);
  if (meta === undefined) {
    return { ok: false, message: `快照不存在：${id}` };
  }
  const profileDir = composed?.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const dir = snapshotDir(env.dshHome, id);

  // 1) reversible: snapshot the state we are about to leave.
  try {
    createSnapshot(env, profileName, composed, {
      trigger: "rollback",
      note: `回滚前状态（目标快照 ${id}）`,
    });
  } catch {
    /* a failed pre-rollback snapshot does not block the rollback */
  }
  // Diagnostic diff against the CURRENT on-disk state (before any restore).
  const preRestoreState = currentThirdPartyState(profileDir);

  const restored = [];
  const failed = [];
  const restoreFile = (rel, target) => {
    const source = join(dir, rel);
    if (!existsSync(source)) return;
    try {
      backupFile(env.dshHome, target, "rollback");
      copyFileSync(source, target);
      restored.push(target);
    } catch (error) {
      failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 2) config files
  if (typeof meta.files?.profileManifest === "string") restoreFile(meta.files.profileManifest, join(profileDir, "package.json"));
  if (typeof meta.files?.homePatch === "string") restoreFile(meta.files.homePatch, homePatchPath(env.dshHome));
  if (typeof meta.files?.profilePatch === "string") restoreFile(meta.files.profilePatch, join(profileDir, "cordis.patch.yml"));
  if (typeof meta.files?.settingsYaml === "string") restoreFile(meta.files.settingsYaml, join(env.dshHome, "settings.yaml"));
  if (typeof meta.files?.pluginManagement === "string" && env.userData !== undefined) {
    const pmPath = join(env.userData, "plugin-management", "state.json");
    if (existsSync(pmPath)) restoreFile(meta.files.pluginManagement, pmPath);
  }

  // 3) third-party package dirs (offline rollback of bad updates)
  for (const [name, rel] of Object.entries(meta.packages ?? {})) {
    const source = join(dir, "packages", rel);
    const target = join(profileDir, "node_modules", ...name.split("/"));
    if (!existsSync(source)) continue;
    try {
      backupDirectory(env.dshHome, target, "rollback");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(source, target, { recursive: true });
      restored.push(target);
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setSnapshotStatus(env.dshHome, id, "rolled-back");
  const suspected = computeSuspected(meta, preRestoreState);
  let disabled = [];
  if (disableSuspected && suspected.suspected.length > 0) {
    disabled = disableSuspectedPlugins(env, composed, suspected.suspected);
  }
  const base =
    failed.length === 0
      ? `已回滚到快照 ${id}\n恢复了 ${restored.length} 项（配置 + 第三方插件目录）。\n重启 DSH 后生效。`
      : `回滚不完整：恢复 ${restored.length} 项，失败 ${failed.length} 项：\n${failed.join("\n")}`;
  return {
    ok: failed.length === 0,
    message: base + suspectedHint(suspected.suspected) + (disabled.length > 0 ? `\n已自动禁用嫌疑插件：${disabled.join("、")}（可稍后重新启用排查）。` : ""),
    restored: restored.length,
    failed: failed.length,
    snapshotId: id,
    suspected: suspected.suspected,
    disabled,
  };
}

/**
 * Write `disabled: true` home-patch rows for the suspected plugins, matched
 * by their loader entry ids in the composed tree (falling back to the short
 * package name). Returns the entry ids that were disabled.
 */
function disableSuspectedPlugins(env, composed, suspected) {
  const disabled = [];
  for (const item of suspected) {
    const name = String(item.name ?? "");
    if (name === "") continue;
    const ids = new Set();
    for (const row of composed?.rows ?? []) {
      if (row === null || typeof row !== "object") continue;
      if (typeof row.name !== "string" || row.name !== name) continue;
      if (typeof row.id === "string" && row.id.length > 0) {
        ids.add(row.id);
        const short = row.id.split(":").pop();
        if (short.length > 0) ids.add(short);
      }
    }
    if (ids.size === 0) ids.add(String(name).split("/").pop() ?? name);
    for (const entryId of ids) {
      const result = setEnabledRow(env.dshHome, entryId, false);
      if (result.ok && !disabled.includes(entryId)) disabled.push(entryId);
    }
  }
  return disabled;
}

/** Whether a snapshot is a viable rollback target. */
export function rollbackCandidates(list) {
  return list.filter((snap) => snap.status === "verified" || snap.status === "pending" || snap.status === "failed");
}

/**
 * Current third-party package state of the profile on disk: name → version
 * (manifest deps + bundles, natives excluded).
 */
function currentThirdPartyState(profileDir) {
  const manifest = readProfileManifest(profileDir);
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []),
  ]);
  const state = {};
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (name.startsWith("@deepseek-ai/") || CORE_NAMES.has(name)) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, "node_modules", ...name.split("/"), "package.json"), "utf8"));
      state[name] = typeof pkg?.version === "string" ? pkg.version : "";
    } catch {
      state[name] = "";
    }
  }
  return state;
}

/**
 * Diagnostic diff: which third-party plugins appeared or changed AFTER the
 * snapshot was taken — the likely crash culprits when DSH stopped booting.
 * `added` = on disk now, absent in the snapshot; `changed` = same name but a
 * different version than the snapshot recorded.
 */
function computeSuspected(snapshotMeta, currentState) {
  const known = snapshotMeta?.packageVersions ?? {};
  const added = [];
  const changed = [];
  for (const [name, version] of Object.entries(currentState)) {
    if (!Object.hasOwn(known, name)) {
      added.push({ name, version });
    } else if (known[name] !== version) {
      changed.push({ name, from: known[name], to: version });
    }
  }
  return { added, changed, suspected: [...added, ...changed] };
}

function suspectedHint(suspected) {
  if (suspected.length === 0) return "";
  const names = suspected.map((s) => s.name).join("、");
  return `\n⚠ 以下插件在快照之后新增/变更（可能是崩溃原因）：${names}。建议用「隔离运行」验证原生 DSH，再逐个放行。`;
}

/**
 * Import a Kidai Snapshot Guard export zip (single-file full backup) and
 * restore it — the external recovery path when DSH itself cannot boot. The
 * zip is self-contained: config/ (profile manifest, home/profile patches,
 * settings.yaml), desktop/plugin-management.json and packages/<name>/ dirs.
 * A KPR snapshot of the current state is taken first so the import is
 * reversible.
 * @param zipBuffer - the zip file bytes.
 * @param disableSuspected - also disable plugins that appeared/changed after
 * the backup (see {@link rollbackSnapshot}).
 */
export async function importZipAndRestore(env, profileName, composed, zipBuffer, { disableSuspected = false } = {}) {
  const AdmZip = loadAdmZip(env);
  if (AdmZip === undefined) {
    return { ok: false, message: "无法加载 zip 库（adm-zip 不可用）" };
  }
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (error) {
    return { ok: false, message: `无法打开 zip：${error instanceof Error ? error.message : String(error)}` };
  }
  const entries = zip.getEntries();
  const manifestEntry = entries.find((entry) => entry.entryName === "manifest.json");
  if (manifestEntry === undefined) {
    return { ok: false, message: "不是 Kidai Snapshot 备份（缺少 manifest.json）" };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  } catch {
    return { ok: false, message: "备份 manifest.json 无法解析" };
  }
  if (manifest !== null && typeof manifest === "object" && typeof manifest.format === "string" && manifest.format !== "kidai-snapshot") {
    return { ok: false, message: "不是 Kidai Snapshot 备份（format 不匹配）。" };
  }
  const profileDir = composed?.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const restored = [];
  const failed = [];
  // Diagnostic diff against the CURRENT on-disk state (before any restore).
  const preRestoreState = currentThirdPartyState(profileDir);
  const restoreEntry = (zipRel, target, label) => {
    const entry = entries.find((e) => e.entryName === zipRel);
    if (entry === undefined) return; // tolerate absent optional files (old/slim backups)
    try {
      if (existsSync(target)) backupFile(env.dshHome, target, "import");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.getData());
      restored.push(target);
    } catch (error) {
      failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  restoreEntry("config/profile.package.json", join(profileDir, "package.json"), "profile manifest");
  restoreEntry("config/cordis.patch.yml.home", homePatchPath(env.dshHome), "home patch");
  restoreEntry("config/cordis.patch.yml.profile", join(profileDir, "cordis.patch.yml"), "profile patch");
  restoreEntry("config/settings.yaml", join(env.dshHome, "settings.yaml"), "settings");
  if (env.userData !== undefined) {
    restoreEntry("desktop/plugin-management.json", join(env.userData, "plugin-management", "state.json"), "plugin-management");
  }
  // packages/<name>/... → profile/node_modules/<name>
  // Strictly sanitize untrusted zip entry names so a crafted backup cannot
  // write outside the profile's node_modules (zip-slip). When the export
  // manifest carries a name→rel packages map we use it to reconstruct the full
  // (possibly scoped) package name and place/back it up per package; otherwise
  // we fall back to a strict tree walk (unscoped names).
  const prefix = "packages/";
  const exportedPackages = manifest && typeof manifest.packages === "object" ? manifest.packages : null;

  const placeEntries = (zipPrefix, name) => {
    const base = join(profileDir, "node_modules", ...name.split("/"));
    // Back up the existing package dir first so the import stays reversible.
    if (existsSync(base)) {
      try {
        backupDirectory(env.dshHome, base, "import");
      } catch (error) {
        failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let wrote = false;
    for (const entry of entries) {
      if (!entry.entryName.startsWith(zipPrefix)) continue;
      const inner = entry.entryName.slice(zipPrefix.length);
      if (inner.length === 0) continue;
      if (inner.includes("..") || inner.includes("\\") || inner.startsWith("/")) continue;
      const parts = inner.split("/");
      try {
        const target = join(base, ...parts);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.getData());
        wrote = true;
      } catch (error) {
        failed.push(`${name}/${inner}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if ((wrote || existsSync(base)) && !restored.includes(base)) restored.push(base);
  };

  if (exportedPackages !== null) {
    for (const [name, rel] of Object.entries(exportedPackages)) {
      if (typeof name !== "string" || name.length === 0 || name.includes("..") || name.includes("\\")) continue;
      placeEntries(`${prefix}${name}/`, name);
    }
  } else {
    // Legacy export without a packages map: strict tree walk (unscoped names).
    for (const entry of entries) {
      if (!entry.entryName.startsWith(prefix)) continue;
      const rest = entry.entryName.slice(prefix.length);
      if (rest.length === 0) continue;
      if (rest.includes("..") || rest.includes("\\") || rest.startsWith("/")) continue;
      const slash = rest.indexOf("/");
      if (slash <= 0) continue;
      const name = rest.slice(0, slash);
      const relPath = rest.slice(slash + 1);
      if (!/^[A-Za-z0-9@._-]+$/.test(name)) continue;
      if (relPath.length === 0 || relPath.includes("..")) continue;
      const base = join(profileDir, "node_modules", ...name.split("/"));
      try {
        backupDirectory(env.dshHome, base, "import");
        mkdirSync(base, { recursive: true });
        writeFileSync(join(base, ...relPath.split("/")), entry.getData());
        if (!restored.includes(base)) restored.push(base);
      } catch (error) {
        failed.push(`${name}/${relPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const suspected = computeSuspected(manifest, preRestoreState);
  let disabled = [];
  if (disableSuspected && suspected.suspected.length > 0) {
    disabled = disableSuspectedPlugins(env, composed, suspected.suspected);
  }
  const base =
    failed.length === 0
      ? `已从导出 zip 恢复（${restored.length} 项，来源 ${String(manifest.note ?? manifest.id ?? "备份")}）。\n重启 DSH 后生效。`
      : `恢复不完整：成功 ${restored.length} 项，失败 ${failed.length} 项：\n${failed.join("\n")}`;
  return {
    ok: failed.length === 0,
    message: base + suspectedHint(suspected.suspected) + (disabled.length > 0 ? `\n已自动禁用嫌疑插件：${disabled.join("、")}（可稍后重新启用排查）。` : ""),
    restored: restored.length,
    failed: failed.length,
    importedFrom: String(manifest.id ?? ""),
    suspected: suspected.suspected,
    disabled,
  };
}

/**
 * Resolve adm-zip from the DSH installation (or the ambient node_modules),
 * so the external manager can read Kidai Snapshot Guard export zips offline.
 */
function loadAdmZip(env) {
  try {
    const anchors = [];
    if (env?.unpackedRoot !== undefined) anchors.push(join(env.unpackedRoot, "package.json"));
    anchors.push(fileURLToPath(new URL(".", import.meta.url)));
    for (const anchor of anchors) {
      try {
        const mod = createRequire(anchor)("adm-zip");
        if (mod !== undefined) return mod;
      } catch {
        /* try the next anchor */
      }
    }
  } catch {
    /* unavailable */
  }
  return undefined;
}

/**
 * Restore a FULL-ENVIRONMENT migration zip (see
 * `exportFullEnvironment` in the in-DSH guard). Extracts the `dsh/` tree into
 * `home` (config + offline packages), the `desktop/` tree into the desktop
 * user-data dir (profile-selection / plugin-management), and rebuilds the
 * recorded junction/symlink entries. Current files are backed up first so the
 * restore is itself reversible.
 * @returns `{ ok, restored, linksBuilt, manifest }`
 */
export function importFullEnvironmentZip(env, home, zipPath, { userData, profileName } = {}) {
  const AdmZip = loadAdmZip(env);
  if (AdmZip === undefined) return { ok: false, message: "adm-zip 不可用（DSH 安装缺失）" };
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (error) {
    return { ok: false, message: `无法读取 zip：${error instanceof Error ? error.message : String(error)}` };
  }
  const entries = zip.getEntries();
  const manifestEntry = entries.find((entry) => entry.entryName === "env-manifest.json");
  if (manifestEntry === undefined) return { ok: false, message: "不是完整环境备份（缺少 env-manifest.json）。" };
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch {
    manifest = {};
  }
  if (manifest.format !== "kidai-env") {
    return { ok: false, message: "不是完整环境备份（format 不匹配）。" };
  }
  const userDataDir = userData ?? env?.userData;
  const restored = [];
  const backupRoot = join(home, ".kidai-remote-backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupRoot, `${stamp}-env-restore`);
  const backupTarget = (target) => {
    try {
      mkdirSync(backupPath, { recursive: true });
      cpSync(target, join(backupPath, String(target).split(/[\\/]/).pop() || "file"), { recursive: true });
    } catch {
      /* best-effort */
    }
  };
  const restoreEntry = (entry) => {
    if (entry.isDirectory) return;
    let base;
    let rel;
    if (entry.entryName.startsWith("dsh/")) { base = home; rel = entry.entryName.slice("dsh/".length); }
    else if (entry.entryName.startsWith("desktop/")) { base = userDataDir; rel = entry.entryName.slice("desktop/".length); }
    else return;
    if (rel.length === 0 || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) return;
    const target = join(base, rel);
    let content;
    try {
      content = entry.getData();
    } catch {
      return;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) backupTarget(target);
      writeFileSync(target, content);
      restored.push(target);
    } catch {
      /* keep going */
    }
  };
  for (const entry of entries) restoreEntry(entry);

  const linksEntry = entries.find((entry) => entry.entryName === "links.json");
  let linksBuilt = 0;
  if (linksEntry !== undefined) {
    try {
      const links = JSON.parse(zip.readAsText(linksEntry));
      for (const link of Array.isArray(links) ? links : []) {
        if (typeof link?.path !== "string" || typeof link?.target !== "string") continue;
        let rel = link.path.startsWith("dsh/") ? link.path.slice("dsh/".length) : link.path;
        if (rel.length === 0 || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) continue;
        const target = join(home, rel);
        try {
          mkdirSync(dirname(target), { recursive: true });
          if (!existsSync(target)) {
            symlinkSync(link.target, target, link.type === "junction" ? "junction" : "file");
            linksBuilt++;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { ok: true, restored: restored.length, linksBuilt, manifest };
}
