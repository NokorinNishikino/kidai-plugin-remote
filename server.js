#!/usr/bin/env node
/**
 * Kidai Plugin Remote — server.js
 *
 * Standalone manager server (no DSH runtime involved). Serves the local web
 * UI and the manager API on 127.0.0.1. Safe to run while DSH Desktop is
 * active: every inspection is read-only; mutations (toggles, isolation) are
 * explicit user actions with backups.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  probeEnvironment,
  locateDesktopInstall,
  locateDesktopUserData,
  isDesktopRunning,
  resolveProfileDir,
} from "./lib/dsh-env.js";
import { composeProfileRows, readProfileManifest, profileBundles } from "./lib/profile.js";
import { buildInstalledView } from "./lib/inventory.js";
import { analyzeProfile, recentDesktopLogErrors } from "./lib/conflicts.js";
import {
  setEnabledRow,
  readHomePatch,
  parsePatchFile,
  backupFile,
  backupRoot,
  homePatchPath,
} from "./lib/patches.js";
import {
  launchDesktop,
  abortIsolation,
  currentRunState,
  checkIsolationStale,
  isolationMarkerPath,
  runCliDump,
  minimizeManagerConsole,
  buildOverlay,
  managerDataDir,
} from "./lib/launcher.js";
import {
  scanOrphanPlugins,
  mountOrphan,
  removeOrphanFiles,
  uninstallPlugin,
} from "./lib/plugin-mgmt.js";
import {
  createSnapshot,
  listSnapshots,
  rollbackSnapshot,
  setSnapshotStatus,
  reconcilePendingSnapshots,
  importZipAndRestore,
  setSnapshotNote,
  importFullEnvironmentZip,
} from "./lib/snapshots.js";


const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.KPR_PORT ?? 4877);
const HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// activity log (ring buffer)
// ---------------------------------------------------------------------------
const activity = [];
function log(level, message, extra) {
  const entry = { at: new Date().toISOString(), level, message, ...(extra ?? {}) };
  activity.push(entry);
  if (activity.length > 400) activity.splice(0, activity.length - 400);
  if (level === "error") process.stderr.write(`[kpr] ${message}\n`);
  else if (level === "info") process.stdout.write(`[kpr] ${message}\n`);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const launchState = { active: false, current: undefined };

// ---------------------------------------------------------------------------
// settings (persisted in the manager data dir)
// ---------------------------------------------------------------------------
function settingsPath() {
  return join(managerDataDir(), "settings.json");
}

const THEME_NAMES = ["dark", "light", "ds-blue", "sage", "violet", "teal", "coral", "rose"];

function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return {
      snapshotOnLaunch: true,
      snapshotOnMutate: true,
      keepSnapshots: 12,
      afterLaunch: "minimize", // "exit" | "keep" | "minimize"
      theme: "dark",
      ...(parsed !== null && typeof parsed === "object" ? parsed : {}),
    };
  } catch {
    return { snapshotOnLaunch: true, snapshotOnMutate: true, keepSnapshots: 12, afterLaunch: "minimize", theme: "dark" };
  }
}

const settings = loadSettings();

function saveSettings() {
  try {
    mkdirSync(managerDataDir(), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/** Whether the in-DSH snapshot-guard plugin is installed in the profile. */
function guardInstalled(env, profileName) {
  const manifest = readProfileManifest(resolveProfileDir(profileName, env.dshHome));
  const deps = Object.keys(manifest.dependencies ?? {});
  const bundles = profileBundles(manifest);
  return deps.includes("kidai-snapshot-guard") || bundles.includes("kidai-snapshot-guard");
}

/** Take a PENDING snapshot before a mutation / launch, per settings. */
function snapshotBefore(env, profileName, composed, trigger, note) {
  const enabled = trigger === "launch" ? settings.snapshotOnLaunch : settings.snapshotOnMutate;
  if (!enabled) return undefined;
  try {
    const meta = createSnapshot(env, profileName, composed, { trigger, note });
    log("info", `snapshot ${meta.id} (${trigger}) created — pending`);
    return meta;
  } catch (error) {
    log("error", `snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// lifecycle: UI heartbeat linkage, auto-exit, launch reports, KSG notices
// ---------------------------------------------------------------------------
let lastUiPing = Date.now();
let shuttingDown = false;

/** Gracefully stop the manager server (the UI window detects the drop and closes). */
function shutdownAutoExit(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Kidai Plugin Remote auto-exiting: ${reason}`);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 400);
}

function launchReportPath() {
  return join(managerDataDir(), "last-launch-report.json");
}

function writeLaunchReport(report) {
  try {
    mkdirSync(managerDataDir(), { recursive: true });
    writeFileSync(launchReportPath(), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

function readLaunchReport() {
  try {
    return JSON.parse(readFileSync(launchReportPath(), "utf8"));
  } catch {
    return undefined;
  }
}

/** Directly write a launch notice into the in-DSH guard's notice file, so the
 * 纪代备份 page can show a success toast inside DSH without needing the port. */
function writeKsgLaunchNotice(env, notice) {
  try {
    const dir = join(env.dshHome, "guard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kidai-launch-notice.json"), `${JSON.stringify(notice, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/** "启动后自动关闭" scheduling: monitor briefly after a successful launch, then exit. */
function scheduleAutoExit(reason) {
  const monitorMs = 10_000;
  log("info", `after-launch auto-exit armed: exiting in ${monitorMs / 1000}s (${reason})`);
  setTimeout(() => shutdownAutoExit(reason), monitorMs);
}

/** UI heartbeat watchdog: if the UI window closed and nothing needs background
 *  值守 (an isolated run waiting for DSH to exit), shut the server down too.
 *  Also enforces one-shot isolation: any pending isolation whose recorded DSH
 *  is gone is auto-restored here, so isolation never leaks into a launch the
 *  user does outside the manager. */
function startUiWatchdog() {
  setInterval(() => {
    if (shuttingDown) return;
    try {
      const stale = checkIsolationStale(probeEnvironment());
      if (stale.action !== "none") {
        log("warn", `isolation auto-recovered (${stale.action}): ${stale.message}`);
      }
    } catch {
      /* best-effort */
    }
    if (Date.now() - lastUiPing > 15_000) {
      const state = currentRunState();
      const isolating = state?.isolating === true;
      if (isolating) return; // keep watching until DSH exits and isolation is restored
      shutdownAutoExit("UI window closed (no background task pending)");
    }
  }, 5_000);
}

function profileFor(env) {
  return env.activeProfile ?? "desktop";
}

/** Whether a self-contained isolation marker is currently active. */
function isolationMarkerActive(home) {
  try {
    const marker = JSON.parse(readFileSync(isolationMarkerPath(home), "utf8"));
    return marker?.active === true;
  } catch {
    return false;
  }
}

function composeFor(env, profileName) {
  return composeProfileRows(env, profileName, {
    includeDesktopShell: profileName === env.activeProfile || profileName === "desktop",
  });
}

// ---------------------------------------------------------------------------
// JSON + static helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolveBody(data.length > 0 ? JSON.parse(data) : {});
      } catch {
        resolveBody({});
      }
    });
    req.on("error", () => resolveBody({}));
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serveStatic(res, pathname) {
  const publicRoot = resolve(ROOT, "public");
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(publicRoot, relative));
  if (!candidate.startsWith(publicRoot) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = extname(candidate).toLowerCase();
  const body = readFileSync(candidate);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
function apiEnv(env) {
  return {
    dshHome: env.dshHome,
    activeProfile: env.activeProfile,
    lastKnownGood: env.lastKnownGood,
    install: env.install,
    desktopExe: env.desktopExe,
    userData: env.userData,
    logsDir: env.logsDir,
    desktopRunning: env.desktopRunning,
    desktopPids: Array.isArray(env.desktopPids) ? env.desktopPids : [],
    nodeVersion: env.nodeVersion,
    systemNode: env.systemNode,
    managerDataDir: managerDataDir(),
    desktopDisabledBundles: env.desktopDisabledBundles,
  };
}

function installedResponse(env, profileName) {
  const composed = composeFor(env, profileName);
  return {
    view: buildInstalledView(env, profileName, composed),
    orphans: scanOrphanPlugins(env, profileName, composed).orphans,
    warnings: composed.warnings,
    layerProblems: composed.layerProblems,
    profilePatchProblem: composed.profilePatchProblem,
    homePatchProblem: composed.homePatchProblem,
    desktopOverlayProblem: composed.desktopOverlayProblem,
  };
}

function preflightResponse(env, profileName) {
  const composed = composeFor(env, profileName);
  const analysis = analyzeProfile(env, profileName, composed, {
    desktopShell: profileName === env.activeProfile || profileName === "desktop",
  });
  return { analysis, composed };
}

async function handleLaunch(env, profileName, mode) {
  if (launchState.active) {
    return { ok: false, skipped: true, message: "已有启动任务在进行中。" };
  }
  if (env.desktopRunning) {
    return { ok: false, skipped: true, message: "DSH Desktop 已在运行；请先退出 DSH，再执行启动。" };
  }
  const composed = composeFor(env, profileName);
  const analysis = analyzeProfile(env, profileName, composed, {
    desktopShell: profileName === env.activeProfile || profileName === "desktop",
  });

  // Snapshot the state we are about to leave (before the launch loads new
  // settings); it stays PENDING until the next boot is healthy.
  const launchSnapshot = snapshotBefore(env, profileName, composed, "launch", mode === "isolated" ? "隔离运行" : "按当前选择启动");

  launchState.active = true;
  launchState.current = {
    launchId: `${Date.now()}`,
    profileName,
    mode,
    startedAt: new Date().toISOString(),
    stage: "spawning",
    events: [],
  };
  const state = launchState.current;
  const pushEvent = (stage, detail) => {
    state.stage = stage;
    state.events.push({ at: new Date().toISOString(), stage, detail });
  };

  (async () => {
    try {
      pushEvent("monitoring", `正在启动 DSH Desktop（${mode === "isolated" ? "隔离运行" : "按当前选择"}）…`);
      const result = await launchDesktop(env, profileName, { mode, composed });
      if (result.ok) {
        pushEvent("success", result.message);
        log("info", `launch ok (${mode}) pid=${result.pid}`);
        // Health commit: this launch was a successful run — promote the
        // pending snapshot (and any older pending ones) to VERIFIED.
        if (launchSnapshot !== undefined) setSnapshotStatus(env.dshHome, launchSnapshot.id, "verified");
        try {
          const reconciled = reconcilePendingSnapshots(env, profileName);
          if (reconciled.verified > 0) log("info", `reconciled ${reconciled.verified} pending snapshot(s) -> verified`);
        } catch {
          /* best-effort */
        }
        state.result = { ok: true, message: result.message, pid: result.pid, mode, findings: analysis.findings };
        if (mode === "isolated") {
          // Restore happens when DSH exits; surface the expectation. Isolation
          // is one-shot: if the manager is not watching (killed / user launched
          // DSH directly), the in-DSH guard auto-restores on the next launch.
          state.result.note = "隔离仅本次启动有效：DSH 退出后自动恢复原插件配置；即使管理器不在值守，下次启动也会自动恢复。";
        }
        // Success toast inside DSH (纪代备份 page) on EVERY launch, so the
        // user always gets in-DSH feedback that the run started cleanly.
        writeKsgLaunchNotice(env, {
          ok: true,
          message: `DSH 启动成功（${mode === "isolated" ? "隔离运行" : "正常"}）`,
          at: new Date().toISOString(),
        });
        // "启动后" behavior from settings:
        //   exit     → record the launch, monitor briefly, then auto-close
        //              KPR. Isolated runs must stay alive to restore config
        //              when DSH exits, so exit mode is ignored there.
        //   minimize → the UI collapses to the monitor strip (default).
        //   keep     → do nothing extra.
        if (settings.afterLaunch === "exit" && mode !== "isolated") {
          // Non-isolated: record the launch for next KPR open, monitor briefly, then close.
          writeLaunchReport({
            ok: true,
            mode,
            message: result.message,
            pid: result.pid,
            at: new Date().toISOString(),
          });
          state.result.autoExit = true;
          scheduleAutoExit(`launch ok (${mode}) with afterLaunch=exit`);
        } else if (mode === "isolated" && settings.afterLaunch === "exit") {
          state.result.note = (state.result.note ?? "") + " 隔离运行期间 KPR 保持值守（自动关闭仅在非隔离启动时生效）。";
        }
      } else {
        pushEvent("failed", result.message ?? result.error ?? "启动失败");
        log("error", `launch failed (${mode}): ${result.message ?? result.error ?? "unknown"}`);
        if (launchSnapshot !== undefined) setSnapshotStatus(env.dshHome, launchSnapshot.id, "failed");
        writeLaunchReport({
          ok: false,
          mode,
          message: result.message ?? result.error ?? "启动失败",
          at: new Date().toISOString(),
          evidence: result.evidence,
          findings: analysis.findings,
          verdict: analysis.verdict,
        });
        state.result = {
          ok: false,
          message: result.message ?? result.error ?? "启动失败",
          skipped: result.skipped === true,
          evidence: result.evidence,
          findings: analysis.findings,
          verdict: analysis.verdict,
          mode,
        };
      }
    } catch (error) {
      pushEvent("failed", error instanceof Error ? error.message : String(error));
      state.result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      launchState.active = false;
    }
  })();

  return {
    accepted: true,
    launchId: state.launchId,
    preflight: { findings: analysis.findings, verdict: analysis.verdict, ok: analysis.ok },
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const path = url.pathname;
  const env = probeEnvironment();

  try {
    if (path === "/api/env") {
      lastUiPing = Date.now();
      const profile = profileFor(env);
      const runState = currentRunState();
      sendJson(res, 200, {
        ok: true,
        env: apiEnv(env),
        settings,
        guardInstalled: guardInstalled(env, profile),
        pendingSnapshots: listSnapshots(env, profile).filter((snap) => snap.status === "pending").length,
        lastReport: readLaunchReport() ?? undefined,
        isolation: {
          active: runState?.isolating === true,
          pid: runState?.pid ?? null,
          marker: isolationMarkerActive(env.dshHome),
        },
      });
      return;
    }
    if (path === "/api/launch-report/ack" && req.method === "POST") {
      try {
        unlinkSync(launchReportPath());
      } catch {
        /* already gone */
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === "/api/plugins") {
      const profile = url.searchParams.get("profile") ?? profileFor(env);
      const payload = installedResponse(env, profile);
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }
    if (path === "/api/preflight") {
      const profile = url.searchParams.get("profile") ?? profileFor(env);
      const { analysis, composed } = preflightResponse(env, profile);
      const dump = await runCliDump(env, profile, undefined);
      sendJson(res, 200, {
        ok: true,
        analysis,
        composedRows: composed.rows,
        dump: {
          ok: dump.ok,
          exitCode: dump.exitCode,
          stdout: dump.stdout.slice(0, 60_000),
          stderr: dump.stderr.slice(0, 8_000),
          nodeInfo: dump.nodeInfo,
        },
      });
      return;
    }
    if (path === "/api/toggle" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      snapshotBefore(env, profile, composeFor(env, profile), "toggle", `启停 ${body.entryId}`);
      const result = setEnabledRow(env.dshHome, body.entryId, body.enabled === true);
      if (result.ok) log("info", `toggle ${body.entryId} -> ${body.enabled === true ? "enabled" : "disabled"}`);
      else log("error", `toggle failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result, view: installedResponse(env, profile).view });
      return;
    }
    if (path === "/api/orphans/mount" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const composed = composeFor(env, profile);
      snapshotBefore(env, profile, composed, "mutate", `装载孤儿 ${body.packageName}`);
      const result = await mountOrphan(env, profile, composed, body.packageName, { disabled: body.disabled === true });
      if (result.ok) log("info", `mount orphan ${body.packageName}`);
      else log("error", `mount orphan failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result, view: installedResponse(env, profile).view });
      return;
    }
    if (path === "/api/orphans/remove" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const composed = composeFor(env, profile);
      snapshotBefore(env, profile, composed, "mutate", `删除孤儿残留 ${body.packageName}`);
      const result = await removeOrphanFiles(env, profile, composed, body.packageName);
      if (result.ok) log("info", `remove orphan files ${body.packageName} (removed=${result.removed})`);
      else log("error", `remove orphan failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result, view: installedResponse(env, profile).view });
      return;
    }
    if (path === "/api/uninstall" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const composed = composeFor(env, profile);
      snapshotBefore(env, profile, composed, "mutate", `卸载 ${body.packageName}`);
      const result = await uninstallPlugin(env, profile, composed, body.packageName);
      if (result.ok) log("info", `uninstall ${body.packageName}`);
      else log("error", `uninstall failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result, view: installedResponse(env, profile).view });
      return;
    }
    if (path === "/api/snapshots") {
      const profile = url.searchParams.get("profile") ?? profileFor(env);
      sendJson(res, 200, { ok: true, snapshots: listSnapshots(env, profile) });
      return;
    }
    if (path === "/api/snapshots/note" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const result = setSnapshotNote(env.dshHome, body.id, body.note);
      if (result.ok) log("info", `snapshot note updated: ${body.id}`);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (path === "/api/snapshots/rollback" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      if (env.desktopRunning) {
        sendJson(res, 200, { ok: true, result: { ok: false, message: "DSH Desktop 正在运行，请先退出 DSH 再回滚。" } });
        return;
      }
      const composed = composeFor(env, profile);
      const result = await rollbackSnapshot(env, profile, composed, body.id, { disableSuspected: body.disableSuspected === true });
      if (result.ok) log("info", `rollback to ${body.id} (restored ${result.restored})`);
      else log("error", `rollback failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (path === "/api/snapshots/import-zip" && req.method === "POST") {
      const profile = url.searchParams.get("profile") ?? profileFor(env);
      if (env.desktopRunning) {
        sendJson(res, 200, { ok: true, result: { ok: false, message: "DSH Desktop 正在运行，请先退出 DSH 再导入恢复。" } });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        sendJson(res, 200, { ok: true, result: { ok: false, message: "未收到 zip 内容" } });
        return;
      }
      const composed = composeFor(env, profile);
      const result = await importZipAndRestore(env, profile, composed, buffer, { disableSuspected: url.searchParams.get("disableSuspected") === "1" });
      if (result.ok) log("info", `import-zip restore ok (${result.restored} items)`);
      else log("error", `import-zip restore failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (path === "/api/env-restore" && req.method === "POST") {
      const profile = profileFor(env);
      if (env.desktopRunning) {
        sendJson(res, 200, { ok: true, result: { ok: false, message: "DSH Desktop 正在运行，请先退出 DSH 再恢复完整环境。" } });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        sendJson(res, 200, { ok: true, result: { ok: false, message: "未收到 zip 内容" } });
        return;
      }
      const tmp = join(managerDataDir(), `env-restore-${Date.now()}.zip`);
      writeFileSync(tmp, buffer);
      const result = importFullEnvironmentZip(env, env.dshHome, tmp, { userData: env.userData, profileName: profile });
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if (result.ok) log("info", `env-restore ok (${result.restored} files, ${result.linksBuilt} links)`);
      else log("error", `env-restore failed: ${result.message}`);
      sendJson(res, 200, { ok: true, result });
      return;
    }
    if (path === "/api/open" && req.method === "POST") {
      const body = await readBody(req);
      const target = String(body.path ?? "");
      if (target.length === 0) {
        sendJson(res, 200, { ok: true });
        return;
      }
      try {
        spawn("explorer.exe", [target], { detached: true, stdio: "ignore" }).unref();
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 200, { ok: false });
      }
      return;
    }
    if (path === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      if (typeof body.snapshotOnLaunch === "boolean") settings.snapshotOnLaunch = body.snapshotOnLaunch;
      if (typeof body.snapshotOnMutate === "boolean") settings.snapshotOnMutate = body.snapshotOnMutate;
      if (typeof body.keepSnapshots === "number" && body.keepSnapshots >= 1 && body.keepSnapshots <= 100) settings.keepSnapshots = Math.floor(body.keepSnapshots);
      if (body.afterLaunch === "exit" || body.afterLaunch === "keep" || body.afterLaunch === "minimize") settings.afterLaunch = body.afterLaunch;
      if (THEME_NAMES.includes(body.theme)) settings.theme = body.theme;
      saveSettings();
      sendJson(res, 200, { ok: true, settings });
      return;
    }
    if (path === "/api/settings") {
      const profile = url.searchParams.get("profile") ?? profileFor(env);
      sendJson(res, 200, {
        ok: true,
        settings,
        guardInstalled: guardInstalled(env, profile),
        managerDataDir: managerDataDir(),
      });
      return;
    }
    if (path === "/api/launch" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const mode = body.mode === "isolated" ? "isolated" : "desktop";
      const result = await handleLaunch(env, profile, mode);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (path === "/api/launch-status") {
      sendJson(res, 200, {
        ok: true,
        active: launchState.active,
        current: launchState.current ?? undefined,
      });
      return;
    }
    if (path === "/api/abort-isolation" && req.method === "POST") {
      const body = await readBody(req);
      const profile = body.profile ?? profileFor(env);
      const result = abortIsolation(env, profile);
      if (result.ok) log("info", "isolation aborted, files restored");
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (path === "/api/run-state") {
      sendJson(res, 200, { ok: true, runState: currentRunState() ?? undefined });
      return;
    }
    if (path === "/api/minimize" && req.method === "POST") {
      const result = minimizeManagerConsole(ROOT);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (path === "/api/logs") {
      sendJson(res, 200, {
        ok: true,
        activity: activity.slice(-150),
        desktopLogErrors: recentDesktopLogErrors(env.logsDir, 15),
      });
      return;
    }
    if (path === "/api/backups") {
      const root = backupRoot(env.dshHome);
      let snapshots = [];
      try {
        const { readdirSync } = await import("node:fs");
        snapshots = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .reverse()
          .slice(0, 30);
      } catch {
        /* none yet */
      }
      sendJson(res, 200, { ok: true, backupsRoot: root, snapshots });
      return;
    }
    if (path === "/api/config" ) {
      // raw home patch (read-only preview)
      const home = env.dshHome;
      let homePatch = [];
      let homePatchProblem;
      try {
        const parsed = parsePatchFile(homePatchPath(home), { optional: true, label: "home patches" });
        if (parsed !== undefined) homePatch = parsed;
      } catch (error) {
        homePatchProblem = error instanceof Error ? error.message : String(error);
      }
      sendJson(res, 200, { ok: true, homePatch, homePatchProblem, homePatchPath: homePatchPath(home) });
      return;
    }
    // static
    serveStatic(res, path);
  } catch (error) {
    log("error", `request ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  const env = probeEnvironment();
  log("info", `Kidai Plugin Remote listening on http://${HOST}:${PORT}`);
  log("info", `DSH_HOME=${env.dshHome}  activeProfile=${env.activeProfile}  desktopRunning=${env.desktopRunning}`);
  if (env.install === undefined) log("error", "DSH Desktop install not found — set DSH_DESKTOP_DIR");
  // Reconcile pending snapshots: a healthy last boot (or none pending) verifies them.
  try {
    const reconciled = reconcilePendingSnapshots(env, profileFor(env));
    if (reconciled.verified > 0) log("info", `reconciled ${reconciled.verified} pending snapshot(s) -> verified (last boot healthy)`);
  } catch {
    /* best-effort */
  }
  startUiWatchdog();
  if (process.env.KPR_NO_OPEN !== "1") openBrowser(`http://${HOST}:${PORT}`);
});

function openBrowser(url) {
  const candidates = [
    join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) {
    try {
      spawn(found, ["--app=" + url, "--window-size=1180,860"], { detached: true, stdio: "ignore" }).unref();
      return;
    } catch {
      /* fall through to the default browser */
    }
  }
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* no browser */
  }
}

process.on("unhandledRejection", (reason) => {
  log("error", `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
