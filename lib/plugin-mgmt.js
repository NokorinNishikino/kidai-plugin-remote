/**
 * Kidai Plugin Remote — plugin-mgmt.js
 *
 * Plugin-management operations ported from Kidai Plugin Market Hub 1.3.4's
 * plugin-management upgrades, adapted for the standalone (external) manager:
 *
 *   - entry validation (`packageEntryExists`): a package declaring
 *     `dsh.bundle.patch` but with no loadable entry (`main` / `exports["."]` /
 *     Node's `index.js` fallback) is the "misakanet" boot-failure mode —
 *     refuse to mount it and flag it in preflight.
 *   - `scanOrphanPlugins`: packages whose files exist under node_modules /
 *     vendor dirs and declare dsh.bundle/client but are NOT mounted.
 *   - `mountOrphan`: re-mount a declared-but-unmounted plugin (add to
 *     `dsh.profile.bundles`, clear/keep the HOME patch `disabled` row).
 *   - `removeOrphanFiles`: delete leftover files of undeclared plugins
 *     (node_modules dir + vendor copies + `@local` junctions, dangling-safe),
 *     routing declared ones through the real uninstall.
 *   - `uninstallPlugin`: `pnpm remove` + bundle reconciliation + HOME patch
 *     row cleanup by loader entry ids + `@local`/flat-fallback junction
 *     cleanup, with snapshot backup and rollback.
 *
 * The loader-entry ids come from the composed tree (KPR has no live loader),
 * which is exactly what the hub derives from `ctx.loader.entries()`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveProfileDir,
  profilesDir,
  readPluginManagement,
} from "./dsh-env.js";
import {
  homePatchPath,
  parsePatchFile,
  writePatchFile,
  backupFile,
  restoreLatestBackup,
} from "./patches.js";
import { readProfileManifest, profileBundles } from "./profile.js";
import { resolvePackageDir } from "./inventory.js";
import { resolveDshNode } from "./launcher.js";

/** Only plain npm package names / `@local/<name>` may cross the management boundary. */
const NPM_SPEC_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const LOCAL_PREFIX = "@local/";
const CORE_NAMES = new Set(["@deepseek-ai/dsh-base", "dsh-plugin-desktop", "dsh-community-market"]);

// ---------------------------------------------------------------------------
// entry validation (hub 1.3.4 `packageEntryExists` port)
// ---------------------------------------------------------------------------

/** Declared entry candidates (`main`, `exports["."]` string or {default|import|require}). */
export function resolvePackageEntryCandidates(pkgDir, manifest) {
  const candidates = [];
  if (typeof manifest?.main === "string" && manifest.main.length > 0) candidates.push(manifest.main);
  const exportsDot = manifest?.exports?.["."];
  if (typeof exportsDot === "string" && exportsDot.length > 0) candidates.push(exportsDot);
  else if (exportsDot !== null && typeof exportsDot === "object" && !Array.isArray(exportsDot)) {
    const defaultExport = exportsDot.default;
    if (typeof defaultExport === "string" && defaultExport.length > 0) candidates.push(defaultExport);
    else if (typeof exportsDot.import === "string" && exportsDot.import.length > 0) candidates.push(exportsDot.import);
    else if (typeof exportsDot.require === "string" && exportsDot.require.length > 0) candidates.push(exportsDot.require);
  }
  return candidates.map((candidate) =>
    candidate.startsWith("./") ? join(pkgDir, candidate.slice(2)) : join(pkgDir, candidate),
  );
}

/** Node's implicit entry fallback: `<pkgDir>/index.js` (then .mjs/.cjs). */
export function resolveNodeFallbackEntry(pkgDir) {
  for (const name of ["index.js", "index.mjs", "index.cjs"]) {
    const candidate = join(pkgDir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/** Whether a package has any loadable entry file (declared or fallback). */
export function packageEntryExists(pkgDir, manifest) {
  const candidates = resolvePackageEntryCandidates(pkgDir, manifest);
  if (candidates.length > 0) {
    return candidates.some((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  }
  return resolveNodeFallbackEntry(pkgDir) !== null;
}

/** Base package name of a specifier (subpath stripped, scopes kept). */
export function basePackageName(specifier) {
  const parts = String(specifier).split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? specifier;
}

/** Short (last) segment of a package name — `@scope/pkg` → `pkg`. */
function shortName(name) {
  return String(name).split("/").pop() ?? "";
}

// ---------------------------------------------------------------------------
// generic child runner (friendly EPERM like the launcher's runCli)
// ---------------------------------------------------------------------------

/** Run one child process, capturing output, with a kill-on-hang timer. */
export function runChild(command, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let timer = undefined;
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ error, status: -1, stdout, stderr });
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish({ error: new Error("timeout"), timedOut: true, status: -1, stdout, stderr });
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      const friendly = error?.code === "EPERM"
        ? new Error("当前环境禁止子进程输出捕获（沙箱限制）；请在本机正常环境运行管理器。")
        : error;
      finish({ error: friendly, status: -1, stdout, stderr });
    });
    child.on("close", (code) => finish({ status: code ?? -1, stdout, stderr }));
  });
}

/** Resolve the pnpm executable: KPR_PNPM, packaged pnpm (via a modern node), or PATH. */
export function resolvePnpm(env, profileDir) {
  const override = process.env.KPR_PNPM;
  if (override && existsSync(override)) return { kind: "file", path: override, node: process.execPath };
  const packaged = env.unpackedRoot !== undefined
    ? join(env.unpackedRoot, "node_modules", "pnpm", "bin", "pnpm.mjs")
    : undefined;
  if (packaged !== undefined && existsSync(packaged)) {
    const node = resolveDshNode(env);
    if (node !== undefined) {
      return {
        kind: "file",
        path: packaged,
        node: node.run,
        electron: node.electron === true,
        label: node.label,
      };
    }
  }
  return null;
}

function tail(text, limit = 600) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

// ---------------------------------------------------------------------------
// orphan scanning
// ---------------------------------------------------------------------------

/**
 * Scan the profile for orphaned plugin files: packages under `node_modules`
 * (or vendor dirs) that declare dsh.bundle/client but are NOT mounted.
 * Mirrors hub 1.3.4 `scanOrphanPlugins` with the composed tree as the
 * mounted set (KPR has no live loader).
 * @returns `{ orphans }` — each `{ name, path, declared, inBundles, reason, entryOk }`.
 */
export function scanOrphanPlugins(env, profileName, composed) {
  const profileDir = composed.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const orphans = [];
  const seen = new Set();

  // Loader-mounted package names (the running set) from the composed tree.
  const mounted = new Set();
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.name === "string" && row.name.length > 0) mounted.add(basePackageName(row.name));
  }

  const manifest = readProfileManifest(profileDir);
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const bundles = new Set(profileBundles(manifest));
  const desktopDisabledSet = new Set(
    (readPluginManagement(env.userData)?.profiles ?? []).find((item) => item.profileName === profileName)?.disabledBundles ?? [],
  );

  const probe = (pkgDir, name) => {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) return;
    seen.add(name);
    if (name.startsWith("@deepseek-ai/") || CORE_NAMES.has(name)) return;
    const manifestPath = join(pkgDir, "package.json");
    if (!existsSync(manifestPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return;
    }
    const isPlugin = pkg?.dsh?.bundle !== undefined || pkg?.dsh?.client !== undefined;
    if (!isPlugin) return;
    const isMounted = mounted.has(name);
    const isDeclared = declared.has(name);
    if (isDeclared && isMounted) return;
    const inBundles = bundles.has(name);
    const desktopDisabled = desktopDisabledSet.has(name);
    let reason;
    if (!isDeclared) reason = "文件存在但未声明依赖";
    else if (desktopDisabled) reason = "已声明依赖但被桌面插件管理停用";
    else reason = "已声明依赖但未挂载(可能被禁用或残留)";
    orphans.push({
      name,
      path: pkgDir,
      declared: isDeclared,
      inBundles,
      desktopDisabled,
      reason,
      entryOk: packageEntryExists(pkgDir, pkg),
    });
  };

  // 1) direct dependencies declared in the profile manifest.
  for (const name of declared) {
    const dir = join(profileDir, "node_modules", ...name.split("/"));
    if (existsSync(dir)) probe(dir, name);
  }
  // 2) vendor dir copies (.kidai-vendor/*) used by subpackage installs.
  const vendorRoot = join(profileDir, ".kidai-vendor");
  try {
    if (existsSync(vendorRoot)) {
      for (const entry of readdirSync(vendorRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const vendorManifestPath = join(vendorRoot, entry.name, "package.json");
        if (!existsSync(vendorManifestPath)) continue;
        try {
          const vendorManifest = JSON.parse(readFileSync(vendorManifestPath, "utf8"));
          if (typeof vendorManifest?.name === "string" && vendorManifest.name.length > 0) {
            probe(join(vendorRoot, entry.name), vendorManifest.name);
          }
        } catch {
          /* skip unreadable vendor dirs */
        }
      }
    }
  } catch {
    /* vendor scan best-effort */
  }
  // 3) profile node_modules + the flat fallback (profiles/node_modules) —
  //    plugin-looking packages not in deps.
  for (const root of [join(profileDir, "node_modules"), join(profilesDir(env.dshHome), "node_modules")]) {
    try {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "@deepseek-ai") continue;
        if (entry.name.startsWith("@")) {
          const scopeDir = join(root, entry.name);
          for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            probe(join(scopeDir, sub.name), `${entry.name}/${sub.name}`);
          }
        } else {
          probe(join(root, entry.name), entry.name);
        }
      }
    } catch {
      /* node_modules scan best-effort */
    }
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));
  return { orphans };
}

// ---------------------------------------------------------------------------
// helpers shared by mount / remove / uninstall
// ---------------------------------------------------------------------------

/** Loader entry ids (plain + short) for rows whose name matches any given name. */
function entryIdsForName(composed, names) {
  const ids = new Set();
  const wanted = new Set(names.map(basePackageName));
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.name !== "string") continue;
    if (!wanted.has(basePackageName(row.name))) continue;
    if (typeof row.id === "string" && row.id.length > 0) {
      ids.add(row.id);
      const short = row.id.split(":").pop();
      if (short.length > 0) ids.add(short);
    }
  }
  return ids;
}

/** Remove `@local/<seg>` junctions (dangling-safe: rmSync force, no existsSync gate). */
function cleanLocalJunctions(profileDir, names) {
  const localRoot = join(profileDir, "node_modules", "@local");
  const segments = new Set(names.flatMap((name) => [name, shortName(name)]));
  for (const seg of segments) {
    const junctionPath = join(localRoot, ...String(seg).split("/"));
    try {
      rmSync(junctionPath, { recursive: true, force: true });
    } catch {
      /* best-effort junction cleanup */
    }
  }
}

/** Remove HOME patch rows matching any of the given ids (best-effort). */
function dropHomePatchRows(env, ids) {
  try {
    const path = homePatchPath(env.dshHome);
    const doc = parsePatchFile(path, { optional: true, label: "home patches" });
    if (doc === undefined) return false;
    const filtered = doc.filter(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !ids.has(row.id),
    );
    if (filtered.length !== doc.length) {
      writePatchFile(path, filtered);
      return true;
    }
  } catch {
    /* best-effort patch cleanup */
  }
  return false;
}

/**
 * Remove a package from the desktop's private disabled-bundle state
 * (`plugin-management/state.json`) so the next boot mounts its layer again.
 * Returns whether the state changed.
 */
function clearDesktopDisabledBundle(env, profileName, packageName) {
  try {
    const state = readPluginManagement(env.userData);
    const path = state?.path;
    if (path === undefined) return false;
    const profile = (state.profiles ?? []).find((item) => item.profileName === profileName);
    if (profile === undefined || !profile.disabledBundles.includes(packageName)) return false;
    backupFile(env.dshHome, path, "mount");
    const others = state.profiles.filter((item) => item.profileName !== profileName);
    const remaining = profile.disabledBundles.filter((name) => name !== packageName);
    if (remaining.length > 0) others.push({ profileName, disabledBundles: remaining });
    others.sort((a, b) => String(a.profileName).localeCompare(String(b.profileName)));
    writeFileSync(path, `${JSON.stringify({ version: 1, profiles: others }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// mount / remove / uninstall
// ---------------------------------------------------------------------------

/**
 * Mount an orphaned plugin back into the profile: a declared dependency
 * whose files exist but which is not mounted. Adds it to
 * `dsh.profile.bundles` and clears the HOME patch `disabled` row (or writes
 * one when `{ disabled: true }` = "挂载但不启用"). Refuses to mount a
 * `dsh.bundle` package with no loadable entry (misakanet failure mode).
 */
export async function mountOrphan(env, profileName, composed, packageName, options = {}) {
  const mountDisabled = options !== null && typeof options === "object" && options.disabled === true;
  if (typeof packageName !== "string" || !NPM_SPEC_PATTERN.test(packageName)) {
    return { ok: false, packageName: String(packageName ?? ""), message: "无效的包名", restartNeeded: false };
  }
  const profileDir = composed.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, packageName, message: `${profileDir} 没有 package.json，不是 DSH profile`, restartNeeded: false };
  }
  const manifest = readProfileManifest(profileDir);
  if (!Object.hasOwn(manifest.dependencies ?? {}, packageName)) {
    return { ok: false, packageName, message: `${packageName} 不在依赖清单中，无法挂载（如为残留文件，请用「删除文件」）`, restartNeeded: false };
  }
  const pkgDir = join(profileDir, "node_modules", ...packageName.split("/"));
  const pkgManifestPath = join(pkgDir, "package.json");
  if (!existsSync(pkgManifestPath)) {
    return { ok: false, packageName, message: `${packageName} 的包目录不存在: ${pkgDir}`, restartNeeded: false };
  }
  let isBundle = false;
  try {
    const pkgManifest = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
    isBundle = pkgManifest?.dsh?.bundle?.patch !== undefined;
    if (isBundle && !packageEntryExists(pkgDir, pkgManifest)) {
      return {
        ok: false,
        packageName,
        message: `${packageName} 声明了 dsh.bundle 但没有可加载的入口文件（无 main/exports，也没有 index.js）。挂载它会导致 DSH 启动失败（加载器无法解析入口，misakanet 故障模式）。该包很可能不是真正的 DSH 插件（如部署脚本仓库），请改用「删除文件」移除，或改装已发布的 npm 插件。`,
        restartNeeded: false,
      };
    }
  } catch {
    isBundle = false;
  }
  backupFile(env.dshHome, manifestPath, "mount");
  backupFile(env.dshHome, homePatchPath(env.dshHome), "mount");

  let changed = false;
  if (isBundle && !(manifest.dsh?.profile?.bundles ?? []).includes(packageName)) {
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    bundles.push(packageName);
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    changed = true;
  }

  const short = shortName(packageName);
  const entryIds = entryIdsForName(composed, [packageName]);
  try {
    const path = homePatchPath(env.dshHome);
    const doc = parsePatchFile(path, { optional: true, label: "home patches" }) ?? [];
    if (mountDisabled) {
      const existing = doc.some(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          row.disabled === true &&
          (row.id === packageName || row.id === short),
      );
      if (!existing) {
        doc.push({ id: short, disabled: true });
        writePatchFile(path, doc);
        changed = true;
      }
    } else {
      const ids = new Set([packageName, short, ...entryIds]);
      const filtered = doc.filter(
        (row) =>
          row === null ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          row.disabled !== true ||
          !ids.has(row.id),
      );
      if (filtered.length !== doc.length) {
        writePatchFile(path, filtered);
        changed = true;
      }
    }
  } catch {
    /* best-effort patch cleanup */
  }
  if (!mountDisabled && clearDesktopDisabledBundle(env, profileName, packageName)) {
    changed = true;
  }
  return {
    ok: true,
    packageName,
    message: mountDisabled
      ? `已挂载 ${packageName}（不启用）\n已加入 bundles 并写入禁用行，重启 DSH 后生效。`
      : `已重新挂载 ${packageName}\n重启 DSH 后生效。${isBundle ? "" : "\n注意：该包未声明 dsh.bundle，挂载后可能无法作为插件加载。"}`,
    restartNeeded: true,
    changed,
    mounted: true,
    disabled: mountDisabled,
  };
}

/**
 * Delete the on-disk files of an orphaned plugin WITHOUT touching the
 * manifest (undeclared residue). Declared orphans route through the real
 * uninstall. Dangling `@local` junctions are removed with rmSync(force).
 */
export async function removeOrphanFiles(env, profileName, composed, packageName) {
  if (typeof packageName !== "string" || !NPM_SPEC_PATTERN.test(packageName)) {
    return { ok: false, packageName: String(packageName ?? ""), message: "无效的包名", restartNeeded: false };
  }
  const profileDir = composed.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const manifest = readProfileManifest(profileDir);
  if (Object.hasOwn(manifest.dependencies ?? {}, packageName)) {
    return uninstallPlugin(env, profileName, composed, packageName);
  }
  const targets = [];
  const short = shortName(packageName);
  const pkgDir = join(profileDir, "node_modules", ...packageName.split("/"));
  if (existsSync(pkgDir)) targets.push(pkgDir);
  const flatDir = join(profilesDir(env.dshHome), "node_modules", ...packageName.split("/"));
  if (existsSync(flatDir)) targets.push(flatDir);
  const vendorRoot = join(profileDir, ".kidai-vendor");
  try {
    if (existsSync(vendorRoot)) {
      for (const entry of readdirSync(vendorRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.includes(packageName.replace(/\//g, "-")) || entry.name.endsWith(`-${short}`)) {
          targets.push(join(vendorRoot, entry.name));
        }
      }
    }
  } catch {
    /* vendor scan best-effort */
  }
  const localRoot = join(profileDir, "node_modules", "@local");
  for (const seg of new Set([packageName, short])) {
    const junctionPath = join(localRoot, ...String(seg).split("/"));
    try {
      rmSync(junctionPath, { recursive: true, force: true });
      if (existsSync(junctionPath)) targets.push(junctionPath);
    } catch {
      /* best-effort */
    }
  }
  let removed = 0;
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* keep going */
    }
  }
  if (removed === 0) {
    return { ok: false, packageName, message: `未找到 ${packageName} 的残留文件`, restartNeeded: false };
  }
  return { ok: true, packageName, message: `已删除 ${packageName} 的残留文件（${removed} 项）\n目录：${profileDir}`, restartNeeded: false, removed };
}

/**
 * Uninstall one third-party plugin: snapshot the profile files, run
 * `pnpm remove <name>`, reconcile the bundle layer, clean `@local` /
 * flat-fallback junctions, and drop any HOME patch row for it (matched by
 * real name, short names, and composed loader entry ids). Refuses
 * native/core packages. Rolls back on failure.
 */
export async function uninstallPlugin(env, profileName, composed, packageName) {
  if (typeof packageName !== "string" || packageName.trim().length === 0) {
    return { ok: false, packageName: String(packageName ?? ""), message: "无效的包名", restartNeeded: false };
  }
  const isLocalLinked = packageName.startsWith(LOCAL_PREFIX);
  const realName = isLocalLinked ? packageName.slice(LOCAL_PREFIX.length) : packageName;
  if (!NPM_SPEC_PATTERN.test(realName)) {
    return { ok: false, packageName, message: "无效的包名", restartNeeded: false };
  }
  if (realName.startsWith("@deepseek-ai/") || CORE_NAMES.has(realName)) {
    return { ok: false, packageName, message: `${packageName} 是 DSH 核心插件，不能卸载`, restartNeeded: false };
  }
  const profileDir = composed.profileDir ?? resolveProfileDir(profileName, env.dshHome);
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, packageName, message: `${profileDir} 没有 package.json，不是 DSH profile`, restartNeeded: false };
  }
  const manifest = readProfileManifest(profileDir);
  if (!Object.hasOwn(manifest.dependencies ?? {}, realName)) {
    return { ok: false, packageName, message: `${realName} 未在依赖清单中，无法卸载`, restartNeeded: false };
  }
  const pnpm = resolvePnpm(env, profileDir);
  if (pnpm === null) {
    return { ok: false, packageName, message: "pnpm 不可用（可设置 KPR_PNPM 指向 pnpm 可执行文件，或安装 pnpm）", restartNeeded: false };
  }

  backupFile(env.dshHome, manifestPath, "uninstall");
  backupFile(env.dshHome, homePatchPath(env.dshHome), "uninstall");

  const command = pnpm.kind === "file" ? pnpm.node : "pnpm";
  const args = pnpm.kind === "file" ? [pnpm.path, "remove", realName] : ["remove", realName];
  const outcome = await runChild(command, args, {
    cwd: profileDir,
    timeoutMs: 300_000,
    env: {
      ...process.env,
      DSH_HOME: env.dshHome,
      CI: "true",
      ...(pnpm.electron === true ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
  const failed = outcome.error !== undefined || outcome.timedOut === true || outcome.status !== 0;
  if (failed) {
    restoreLatestBackup(env.dshHome, manifestPath, "uninstall");
    restoreLatestBackup(env.dshHome, homePatchPath(env.dshHome), "uninstall");
    const detail = outcome.error !== undefined
      ? outcome.error.message
      : tail((outcome.stderr ?? outcome.stdout ?? "").trim());
    return {
      ok: false,
      packageName,
      message: `pnpm remove ${realName} 失败：${detail}\n已自动回滚到卸载前状态。`,
      restartNeeded: false,
    };
  }
  const after = readProfileManifest(profileDir);
  if (Object.hasOwn(after.dependencies ?? {}, realName)) {
    restoreLatestBackup(env.dshHome, manifestPath, "uninstall");
    restoreLatestBackup(env.dshHome, homePatchPath(env.dshHome), "uninstall");
    return { ok: false, packageName, message: `卸载后 ${realName} 仍在依赖清单中，已回滚。`, restartNeeded: false };
  }
  // Reconcile bundles: remove the package (both names) from the layer list.
  const bundles = (Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []).filter(
    (name) => name !== realName && name !== packageName,
  );
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } };
  writeFileSync(manifestPath, `${JSON.stringify(after, null, 2)}\n`);
  // Clean `@local/...` junctions (both names) and the flat-fallback junction.
  cleanLocalJunctions(profileDir, [realName, packageName]);
  try {
    rmSync(join(profilesDir(env.dshHome), "node_modules", ...realName.split("/")), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // Drop HOME patch rows for this package (by real/short names + entry ids).
  const shortReal = shortName(realName);
  const shortLocal = shortName(packageName);
  const entryIds = entryIdsForName(composed, [packageName, realName]);
  dropHomePatchRows(env, new Set([realName, packageName, shortReal, shortLocal, ...entryIds]));
  clearDesktopDisabledBundle(env, profileName, realName);
  return {
    ok: true,
    packageName,
    message: `已卸载 ${packageName}\n目录：${profileDir}\n重启 DSH 后生效。`,
    restartNeeded: true,
  };
}
