/**
 * Kidai Plugin Remote — launcher.js
 *
 * Launch engine:
 *   - preflight config dump via the packaged `dsh` CLI (`--dump-config`),
 *     boot-free and safe while DSH is running
 *   - launch DSH Desktop with the user's persisted plugin selection
 *   - isolated run: temporarily disable every third-party bundle (desktop
 *     plugin-management state) AND every third-party entry (home patch),
 *     launch, then restore both on DSH exit or manual abort
 *   - success detection mirrors the desktop's own health commit
 *     (profile-selection state active == lastKnownGood == profile)
 *   - failure evidence: exit code, desktop logs tail, crash-evidence,
 *     selection-state rollback, install-recovery leftovers
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as YAML from "../vendor/yaml/dist/index.js";
import { homePatchPath, writePatchFile, backupFile, restoreLatestBackup, parsePatchFile } from "./patches.js";
import { resolveProfileDir, desktopExePath } from "./dsh-env.js";
import { readProfileManifest, profileBundles, isMutableBundle } from "./profile.js";
import { recentDesktopLogErrors } from "./conflicts.js";
import { createSnapshot, setSnapshotStatus } from "./snapshots.js";

const envSnapshotLogger = (message) => process.stdout.write(`[kpr] ${message}\n`);

/** Time a freshly spawned desktop must stay alive (and health-commit) to count as success. */
const START_OK_MS = 15_000;
/** Hard cap waiting for the health commit before declaring failure. */
const HEALTH_TIMEOUT_MS = 60_000;
/** Poll interval while monitoring. */
const POLL_MS = 500;

/** Manager data root (overlays + run state), with writable-location fallback. */
export function managerDataDir() {
  const override = process.env.KPR_DATA;
  if (override) return override;
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "KidaiPluginRemote"),
    join(process.env.TEMP ?? ".", "KidaiPluginRemote"),
    join(process.cwd(), ".kpr-data"),
  ];
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* try the next location */
    }
  }
  return candidates[0];
}

/**
 * Resolve a Node runtime able to run the packaged `dsh` CLI (needs ≥ 22 for
 * `node:util` `parseEnv` and the dsh engines):
 *   1. `KPR_NODE` env override
 *   2. system node with major ≥ 22
 *   3. the DSH Desktop executable in `ELECTRON_RUN_AS_NODE` mode (its own
 *      official bootstrap for the packaged CLI; zero downloads)
 * @returns `{ kind, label, run }` or undefined when nothing is available.
 */
export function resolveDshNode(env) {
  const envOverride = process.env.KPR_NODE;
  if (envOverride && existsSync(envOverride)) {
    return { kind: "node", label: `Node ${readNodeMajor(envOverride)}（KPR_NODE）`, run: envOverride };
  }
  // Inside the standalone Electron client, process.execPath is the Electron
  // binary (GUI app); without ELECTRON_RUN_AS_NODE it cannot execute CLI
  // scripts, so skip the "system node" probe and go straight to the desktop's
  // electron-as-node runtime (which is the same version family anyway).
  if (process.env.KPR_ELECTRON_CLIENT !== "1") {
    const systemMajor = readNodeMajor(process.execPath);
    if (systemMajor !== undefined && systemMajor >= 22) {
      return { kind: "node", label: `Node ${systemMajor}（系统）`, run: process.execPath };
    }
  }
  if (env.desktopExe !== undefined && existsSync(env.desktopExe)) {
    return {
      kind: "electron",
      label: `Electron-as-Node（${env.desktopExe}）`,
      run: env.desktopExe,
      electron: true,
    };
  }
  return undefined;
}

function readNodeMajor(nodePath) {
  try {
    const output = execFileSync(nodePath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = /^v(\d+)/.exec(output.trim());
    return match === null ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
}

function overlaysDir() {
  return join(managerDataDir(), "overlays");
}

function runStatePath() {
  return join(managerDataDir(), "run-state.json");
}

function readRunState() {
  try {
    return JSON.parse(readFileSync(runStatePath(), "utf8"));
  } catch {
    return undefined;
  }
}

function writeRunState(state) {
  if (state === undefined || state === null) {
    // Clearing the record: remove the file rather than writing "undefined".
    try {
      rmSync(runStatePath(), { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  mkdirSync(managerDataDir(), { recursive: true });
  writeFileSync(runStatePath(), JSON.stringify(state, null, 2));
}

/**
 * Build a patch-overlay file that disables every composed third-party entry
 * whose id is NOT in `keepEnabledIds` (pass `[]` to disable everything —
 * isolation). Native `@deepseek-ai/*` rows are never touched.
 * @returns `{ file, rows, disabledIds }`
 */
export function buildOverlay(env, profileName, composed, keepEnabledIds, { tag = "selection" } = {}) {
  const rows = [];
  const disabledIds = [];
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    const name = typeof row.name === "string" ? row.name : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (id === "" || name.startsWith("@deepseek-ai/")) continue;
    if (keepEnabledIds.has(id)) continue;
    rows.push({ id, disabled: true });
    disabledIds.push(id);
  }
  mkdirSync(overlaysDir(), { recursive: true });
  const file = join(overlaysDir(), `${tag}-${profileName}-${randomBytes(3).toString("hex")}.yml`);
  writePatchFile(file, rows);
  return { file, rows, disabledIds };
}

/** Run the packaged `dsh` CLI's boot-free config dump with an overlay. */
export async function runCliDump(env, profileName, overlayPath) {
  const entry = env.dshCliEntry;
  if (entry === undefined || !existsSync(entry)) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "dsh CLI entry not found (DSH Desktop install missing)", composed: undefined, nodeInfo: undefined };
  }
  const args = ["--profile", profileName];
  if (overlayPath !== undefined) args.push("--patch", overlayPath);
  args.push("--dump-config");
  const result = await runCli(entry, args, env);
  return { ...result, nodeInfo: result.nodeInfo };
}

/** Run one packaged `dsh` CLI command, capturing output. `timeoutMs` kills the child when it hangs. */
export function runCli(entry, args, env, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    const node = resolveDshNode(env);
    if (node === undefined) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "没有可用的 Node ≥ 22 运行时（dsh CLI 需要它）；请设置 KPR_NODE 指向新版 node.exe，或安装较新的 Node.js。",
        nodeInfo: undefined,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let child;
    let timer = undefined;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const spawnEnv = { ...process.env, DSH_HOME: env.dshHome };
    if (node.electron === true) spawnEnv.ELECTRON_RUN_AS_NODE = "1";
    try {
      child = spawn(node.run, [entry, ...args], {
        cwd: env.dshHome,
        env: spawnEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error?.code === "EPERM"
        ? "当前环境禁止子进程输出捕获（沙箱限制）；请在本机正常环境运行管理器。"
        : error instanceof Error ? error.message : String(error);
      finish({ ok: false, exitCode: -1, stdout: "", stderr: message, nodeInfo: node.label });
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: `CLI 校验超时（超过 ${Math.round(timeoutMs / 1000)}s 未完成，已中止）。`,
          nodeInfo: node.label,
        });
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      const message = error?.code === "EPERM"
        ? "当前环境禁止子进程输出捕获（沙箱限制）；请在本机正常环境运行管理器。"
        : error instanceof Error ? error.message : String(error);
      finish({ ok: false, exitCode: -1, stdout, stderr: message, nodeInfo: node.label });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code ?? -1, stdout, stderr, nodeInfo: node.label });
    });
  });
}

/** Parse a `--dump-config` YAML output into rows (best-effort). */
export function parseDumpRows(stdout) {
  try {
    // The dump is YAML with `# ==` source comments; strip comment separators
    // and parse as a plain YAML document.
    const lines = stdout.split(/\r?\n/).filter((line) => !line.startsWith("# =="));
    const parsed = YAML.parse(lines.join("\n"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Wait for the desktop's health commit (selection state active == lastKnownGood
 * == profileName) or an early exit / rollback.
 */
function monitorDesktopStart(env, profileName, child, { onEvent } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const statePath = env.selectionStatePath;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(hardTimeout);
      resolve(result);
    };
    child.on("error", (error) => {
      finish({
        ok: false,
        reason: "spawn-error",
        message: `无法启动 DSH Desktop：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    const timer = setInterval(() => {
      onEvent?.("poll");
      if (child.exitCode !== null) {
        finish({
          ok: false,
          reason: child.exitCode === 0 ? "exited-clean" : "exited",
          exitCode: child.exitCode,
          message: `DSH Desktop 进程已退出（code=${child.exitCode}）`,
        });
        return;
      }
      const state = readSelectionSafe(statePath);
      if (state !== undefined && state.active === profileName && state.lastKnownGood === profileName) {
        finish({
          ok: true,
          reason: "health-commit",
          message: `DSH Desktop 已就绪（health-commit，profile=${profileName}）`,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      if (state !== undefined && state.active !== state.lastKnownGood) {
        finish({
          ok: false,
          reason: "rolled-back",
          message: `profile-selection 显示启动失败回退（active=${state.active}，lastKnownGood=${state.lastKnownGood}）`,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      if (Date.now() - startedAt > START_OK_MS && child.exitCode === null) {
        // Still alive past the grace window but no health commit yet; keep
        // waiting for the hard timeout so slow first boots are not false failures.
        onEvent?.("grace-passed");
      }
    }, POLL_MS);
    const hardTimeout = setTimeout(() => {
      if (child.exitCode === null) {
        finish({
          ok: false,
          reason: "timeout",
          message: `等待 DSH Desktop 就绪超时（${Math.round((Date.now() - startedAt) / 1000)}s），进程仍在运行`,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }, HEALTH_TIMEOUT_MS);
  });
}

function readSelectionSafe(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
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

/** Collect failure evidence after a bad launch. */
export function collectFailureEvidence(env, { exitCode, stderr } = {}) {
  const evidence = {
    exitCode,
    stderr: (stderr ?? "").trim().slice(0, 4000),
    logErrors: recentDesktopLogErrors(env.logsDir, 20),
    crashEvidence: [],
    selectionState: readSelectionSafe(env.selectionStatePath),
  };
  try {
    if (existsSync(env.crashEvidenceDir)) {
      evidence.crashEvidence = readdirSync(env.crashEvidenceDir)
        .filter((name) => /minidump|\.dmp$/i.test(name))
        .slice(0, 10);
    }
  } catch {
    /* ignore */
  }
  return evidence;
}

/**
 * Apply the isolated-run mutation: disable every mutable third-party bundle in
 * the desktop plugin-management state AND every third-party entry in the home
 * patch layer. Returns the previous values for restore.
 *
 * The snapshot guard (`kidai-snapshot-guard` / entry `snapshot-guard`) is
 * EXEMPT: keeping it alive gives the in-DSH guard a chance to auto-restore the
 * previous config on the NEXT launch even when the manager was killed while an
 * isolated run was pending (a "one-shot isolation" guarantee).
 */
export function applyIsolation(env, profileName, composed, { pid } = {}) {
  const pmPath = env.pluginManagementPath;
  const pmBackup = pmPath !== undefined && existsSync(pmPath) ? readFileSync(pmPath, "utf8") : undefined;
  const homePath = homePatchPath(env.dshHome);
  const homeBackup = existsSync(homePath) ? readFileSync(homePath, "utf8") : undefined;

  // 1) plugin-management: disable every mutable third-party bundle except the guard.
  const manifest = readProfileManifest(resolveProfileDir(profileName, env.dshHome));
  const bundles = profileBundles(manifest)
    .filter(isMutableBundle)
    .filter((name) => name !== "kidai-snapshot-guard");
  if (pmPath !== undefined) {
    try {
      const current = JSON.parse(pmBackup ?? '{"version":1,"profiles":[]}');
      const profiles = Array.isArray(current?.profiles) ? current.profiles : [];
      const others = profiles.filter((item) => String(item?.profileName) !== profileName);
      const disabled = [...new Set(bundles)].sort();
      if (disabled.length > 0) others.push({ profileName, disabledBundles: disabled });
      others.sort((a, b) => String(a.profileName).localeCompare(String(b.profileName)));
      mkdirSync(join(pmPath, ".."), { recursive: true });
      writeFileSync(pmPath, JSON.stringify({ version: 1, profiles: others }, null, 2) + "\n");
    } catch (error) {
      return { ok: false, error: `plugin-management 写入失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 2) home patch: disable every composed third-party entry id (guard exempted).
  try {
    const rows = [];
    const existing = parsePatchFile(homePath, { optional: true, label: "home patches" });
    if (existing !== undefined) rows.push(...existing);
    for (const row of composed.rows ?? []) {
      if (row === null || typeof row !== "object") continue;
      const id = typeof row.id === "string" ? row.id : "";
      const name = typeof row.name === "string" ? row.name : "";
      if (id === "" || name.startsWith("@deepseek-ai/")) continue;
      if (id === "snapshot-guard" || name === "kidai-snapshot-guard") continue;
      const index = rows.findIndex((r) => r !== null && typeof r === "object" && r.id === id && r.insert === undefined);
      if (index >= 0) rows[index] = { ...rows[index], disabled: true };
      else rows.push({ id, disabled: true });
    }
    writePatchFile(homePath, rows);
  } catch (error) {
    return { ok: false, error: `home patch 写入失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 3) Self-contained isolation marker (read by the in-DSH guard for one-shot
  //    auto-restore, and by the manager for abort / stale detection).
  try {
    mkdirSync(join(env.dshHome, "guard"), { recursive: true });
    writeFileSync(
      isolationMarkerPath(env.dshHome),
      `${JSON.stringify(
        {
          active: true,
          profile: profileName,
          startedAt: new Date().toISOString(),
          pid: pid ?? null,
          homePatch: homeBackup ?? null,
          pmState: pmBackup ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    /* best-effort; restore falls back to isolate-tagged backups */
  }

  return { ok: true, pmBackup, homeBackup, disabledBundles: bundles };
}

/** Path of the self-contained isolation marker (shared with the in-DSH guard). */
export function isolationMarkerPath(home) {
  return join(home, "guard", "kidai-isolation.json");
}

/**
 * Restore from the isolation marker (original home patch + plugin-management
 * contents embedded in the marker). Clears the marker once consumed.
 * @returns `{ ok, hadMarker, restored }`
 */
export function restoreIsolationMarker(env, profileName) {
  const markerPath = isolationMarkerPath(env.dshHome);
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { ok: false, hadMarker: false, restored: [] };
  }
  if (marker === null || typeof marker !== "object" || marker.active !== true) {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, hadMarker: false, restored: [] };
  }
  const restored = [];
  if (typeof marker.homePatch === "string") {
    try {
      writeFileSync(homePatchPath(env.dshHome), marker.homePatch);
      restored.push(homePatchPath(env.dshHome));
    } catch {
      /* keep going */
    }
  }
  if (typeof marker.pmState === "string" && env.pluginManagementPath !== undefined) {
    try {
      mkdirSync(join(env.pluginManagementPath, ".."), { recursive: true });
      writeFileSync(env.pluginManagementPath, marker.pmState);
      restored.push(env.pluginManagementPath);
    } catch {
      /* keep going */
    }
  }
  try {
    rmSync(markerPath, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, hadMarker: true, restored };
}

/** Restore the pre-isolation files (legacy path: from in-memory applied state). */
export function restoreIsolation(env, profileName, applied) {
  const restored = [];
  if (applied?.pmBackup !== undefined && env.pluginManagementPath !== undefined) {
    try {
      writeFileSync(env.pluginManagementPath, applied.pmBackup);
      restored.push(env.pluginManagementPath);
    } catch {
      /* keep going */
    }
  }
  if (applied?.homeBackup !== undefined) {
    try {
      writeFileSync(homePatchPath(env.dshHome), applied.homeBackup);
      restored.push(homePatchPath(env.dshHome));
    } catch {
      /* keep going */
    }
  }
  return restored;
}

/** Spawn the desktop executable (GUI). detached+unref: DSH runs in its own
 *  process group, so closing the manager (console or UI) never takes DSH
 *  down with it; the child handle stays valid for exit monitoring. */
function spawnDesktop(env) {
  const exe = env.desktopExe;
  if (exe === undefined || !existsSync(exe)) {
    return { error: "未找到 DSH Desktop.exe（安装缺失或 DSH_DESKTOP_DIR 未设置）" };
  }
  const child = spawn(exe, [], {
    cwd: env.dshHome,
    env: { ...process.env, DSH_HOME: env.dshHome },
    windowsHide: false,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { child };
}

/**
 * Launch DSH Desktop.
 * @param mode - `"desktop"` (persisted selection) | `"isolated"`.
 * @returns after the monitor resolves (success or failure with evidence).
 */
export async function launchDesktop(env, profileName, { mode = "desktop", composed } = {}) {
  if (env.desktopRunning) {
    return {
      ok: false,
      skipped: true,
      message: "DSH Desktop 已在运行；如需本次运行生效的变更请先退出 DSH，再点启动。",
    };
  }
  // A normal (non-isolated) launch must NEVER inherit a leftover isolation
  // state: drop any stale marker/record now (keeping the current on-disk
  // configuration) so the in-DSH guard's one-shot auto-restore cannot fire
  // seconds after DSH boots and clobber the config we are launching with.
  if (mode !== "isolated") clearStaleIsolationBeforeLaunch(env);
  const { error, child } = spawnDesktop(env);
  if (error !== undefined) return { ok: false, error };

  try {
    writeRunState({
      pid: child.pid,
      mode,
      profileName,
      startedAt: new Date().toISOString(),
      isolating: mode === "isolated",
    });

    let applied;
    if (mode === "isolated") {
      backupFile(env.dshHome, homePatchPath(env.dshHome), "isolate");
      if (env.pluginManagementPath !== undefined) backupFile(env.dshHome, env.pluginManagementPath, "isolate");
      applied = applyIsolation(env, profileName, composed, { pid: child.pid });
      if (!applied.ok) {
        child.kill();
        writeRunState(undefined);
        return { ok: false, error: applied.error };
      }
    }

    const result = await monitorDesktopStart(env, profileName, child);

    if (!result.ok) {
      const evidence = collectFailureEvidence(env, { exitCode: result.exitCode });
      if (mode === "isolated") {
        const markerRestored = restoreIsolationMarker(env, profileName);
        if (!markerRestored.hadMarker && applied?.ok) restoreIsolation(env, profileName, applied);
      }
      writeRunState(undefined);
      return { ...result, evidence, isolating: mode === "isolated" };
    }

    writeRunState({ ...readRunState(), healthy: true, healthyAt: new Date().toISOString() });
    child.on("close", (code) => {
      // Isolated run: restore the pre-isolation files once DSH exits. The
      // self-contained marker is consumed first; the in-memory applied state
      // is the fallback when the marker write failed.
      if (mode === "isolated" && applied?.ok) {
        try {
          const markerRestored = restoreIsolationMarker(env, profileName);
          if (!markerRestored.hadMarker) restoreIsolation(env, profileName, applied);
        } catch {
          /* best-effort */
        }
      } else if (code === 0) {
        // Clean exit (user quit): save a KNOWN-GOOD snapshot of the state
        // DSH was running with — the external fallback when the in-DSH guard
        // could not take one (e.g. KSG not installed). Marked verified
        // immediately: the system provably ran this configuration.
        try {
          const meta = createSnapshot(env, profileName, composed, {
            trigger: "close",
            note: "DSH 正常退出（KPR 检测，最近一次正常运转状态）",
          });
          if (meta !== undefined) {
            setSnapshotStatus(env.dshHome, meta.id, "verified");
            envSnapshotLogger(`close snapshot ${meta.id} verified`);
          }
        } catch {
          /* best-effort */
        }
      }
      writeRunState(undefined);
    });
    return { ...result, pid: child.pid, isolating: mode === "isolated", mode };
  } catch (error) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    writeRunState(undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Manual abort of an isolated run: restore the pre-isolation files (the DSH
 * process, if any, is left to the user). No longer requires a pending run
 * record: the self-contained isolation marker — or the latest isolate-tagged
 * file backups — is enough, so "can't cancel" states (marker left behind by a
 * killed manager, run record lost) always recover.
 */
export function abortIsolation(env, profileName) {
  const state = readRunState();

  // 1) Self-contained isolation marker first.
  const markerRestored = restoreIsolationMarker(env, profileName);
  if (markerRestored.hadMarker) {
    writeRunState(undefined);
    return {
      ok: true,
      restored: markerRestored.restored,
      marker: true,
      message:
        markerRestored.restored.length > 0
          ? "已结束隔离：原插件配置已恢复（DSH 运行中则下次启动生效）。"
          : "已结束隔离：隔离标记已清除（原配置与当前一致）。",
    };
  }

  // 2) Fall back to the latest isolate-tagged file backups.
  const restored = [];
  const home = restoreLatestBackup(env.dshHome, homePatchPath(env.dshHome), "isolate");
  if (home) restored.push(homePatchPath(env.dshHome));
  if (env.pluginManagementPath !== undefined) {
    const pm = restoreLatestBackup(env.dshHome, env.pluginManagementPath, "isolate");
    if (pm) restored.push(env.pluginManagementPath);
  }

  const hadRecord = state?.isolating === true;
  writeRunState(undefined);
  if (restored.length === 0 && !hadRecord) {
    return { ok: false, message: "当前没有可恢复的隔离配置记录（未发现隔离标记或备份）。" };
  }
  return {
    ok: true,
    restored,
    message:
      restored.length > 0
        ? "已结束隔离：原插件配置已恢复（DSH 运行中则下次启动生效）。"
        : "没有发现残留的隔离配置（运行记录已清除）。",
  };
}

/**
 * One-shot isolation enforcement + stale-record recovery. When the recorded
 * isolated DSH is gone (manager restarted mid-isolation, user quit DSH and
 * relaunched it directly from a shortcut, etc.) the pending isolation is
 * restored immediately, so isolation NEVER leaks into the next launch no
 * matter how DSH is started.
 * @returns `{ action: "none"|"external-launch"|"exited", restored, message }`
 */
export function checkIsolationStale(env) {
  const state = readRunState();
  if (state?.isolating !== true) {
    return { action: "none", message: "" };
  }
  const pids = Array.isArray(env?.desktopPids) ? env.desktopPids : [];
  const recorded = state.pid;
  const running = pids.length > 0;
  const recordedAlive = Number.isInteger(recorded) && recorded > 0 && pids.includes(recorded);
  if (recordedAlive) {
    // The manager's own isolated DSH is still running — keep watching.
    return { action: "none", message: "" };
  }

  const profileName = state.profileName ?? "desktop";
  const markerRestored = restoreIsolationMarker(env, profileName);
  let restored = markerRestored.restored ?? [];
  if (!markerRestored.hadMarker) {
    const home = restoreLatestBackup(env.dshHome, homePatchPath(env.dshHome), "isolate");
    if (home) restored.push(homePatchPath(env.dshHome));
    if (env.pluginManagementPath !== undefined) {
      const pm = restoreLatestBackup(env.dshHome, env.pluginManagementPath, "isolate");
      if (pm) restored.push(env.pluginManagementPath);
    }
  }
  writeRunState(undefined);
  if (running) {
    return {
      action: "external-launch",
      restored,
      message: "检测到 DSH 由外部直接启动，已自动恢复隔离前的插件配置。",
    };
  }
  return {
    action: "exited",
    restored,
    message: "检测到隔离运行的 DSH 已退出，已自动恢复隔离前的插件配置。",
  };
}

/**
 * Drop a leftover isolation marker/run record WITHOUT restoring any file.
 * Used right before a normal (non-isolated) launch: the user is explicitly
 * starting DSH with the current on-disk configuration, and a stale marker
 * would otherwise make the in-DSH guard's one-shot auto-restore fire seconds
 * later and overwrite exactly those settings (e.g. plugin disables) with the
 * pre-isolation snapshot embedded in the marker.
 * A still-watched isolation (recorded PID alive) is left untouched.
 * @returns `{ cleared }` — whether a stale record existed and was dropped.
 */
export function clearStaleIsolationBeforeLaunch(env) {
  const state = readRunState();
  const pids = Array.isArray(env?.desktopPids) ? env.desktopPids : [];
  const recordedAlive =
    state?.isolating === true && Number.isInteger(state?.pid) && state.pid > 0 && pids.includes(state.pid);
  if (recordedAlive) return { cleared: false };
  let dropped = false;
  try {
    if (existsSync(isolationMarkerPath(env.dshHome))) {
      rmSync(isolationMarkerPath(env.dshHome), { force: true });
      dropped = true;
    }
  } catch {
    /* best-effort */
  }
  if (readRunState() !== undefined) {
    writeRunState(undefined);
    dropped = true;
  }
  return { cleared: dropped };
}

/** Whether a launch is currently recorded (used to re-arm auto-restore after a manager restart). */
export function currentRunState() {
  return readRunState();
}

/** Best-effort: minimize the manager's own console window (no-op in hidden consoles). */
export function minimizeManagerConsole(projectRoot) {
  const script = join(projectRoot, "scripts", "minimize-console.ps1");
  if (!existsSync(script)) return { ok: false, message: "minimize-console.ps1 missing" };
  try {
    // stdio:"inherit" attaches the helper to the manager's console so
    // GetConsoleWindow() resolves to the console window and ShowWindowAsync
    // minimizes it. Async + unref: never blocks the launch flow.
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      detached: false,
      windowsHide: false,
      stdio: "inherit",
    }).unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
