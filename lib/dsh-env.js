/**
 * Kidai Plugin Remote — dsh-env.js
 *
 * Locate every DSH artifact the manager needs, entirely outside DSH itself:
 *   - Harness home ($DSH_HOME or ~/.dsh)
 *   - Profiles ( $DSH_HOME/profiles/<name> )
 *   - The DSH Desktop installation (exe + app.asar.unpacked runtime)
 *   - Desktop user data (profile-selection, plugin-management, logs, install-recovery)
 *   - The packaged `dsh` CLI entry (for read-only config dumps / diagnostics)
 *   - Whether the desktop app is currently running (tasklist + lockfile)
 *
 * All paths are best-effort: a missing piece is reported, never fatal, so the
 * manager keeps working for whatever it can reach.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/** Known-name mapping used to discover the packaged desktop app. */
const DESKTOP_APP_DIRNAME = "DSH Desktop";
const DESKTOP_EXE_NAME = "DSH Desktop.exe";
const UNPACKED_REL = join("resources", "app.asar.unpacked");
/** Path of the packaged `dsh` CLI entry, relative to the unpacked root. */
const DSH_CLI_REL = join(
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

/** Resolve the Harness home: $DSH_HOME wins, otherwise ~/.dsh. */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

/** The profiles directory under a Harness home. */
export function profilesDir(home = resolveDshHome()) {
  return join(home, "profiles");
}

/** The directory of one profile under a Harness home. */
export function resolveProfileDir(name, home = resolveDshHome()) {
  if (
    name === "" ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    name === "node_modules"
  ) {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`);
  }
  return join(profilesDir(home), name);
}

/** Candidate desktop install roots, in probe order. */
function desktopInstallCandidates() {
  const list = [];
  const envDir = process.env.DSH_DESKTOP_DIR;
  const envExe = process.env.DSH_DESKTOP_EXE;
  if (envDir) list.push(envDir);
  if (envExe) list.push(dirname(envExe));
  list.push(join("D:", "Deepseek Harness", DESKTOP_APP_DIRNAME)); // known install on this machine
  list.push(join("D:", "Deepseek Harness Desktop", DESKTOP_APP_DIRNAME));
  list.push(join(process.env.LOCALAPPDATA ?? "", "Programs", DESKTOP_APP_DIRNAME));
  list.push(join(process.env.PROGRAMFILES ?? "", DESKTOP_APP_DIRNAME));
  list.push(join(process.env["PROGRAMFILES(X86)"] ?? "", DESKTOP_APP_DIRNAME));
  list.push(join(process.env.APPDATA ?? "", DESKTOP_APP_DIRNAME));
  return list;
}

/** Probe the registry (best-effort) for a DSH Desktop install location. */
function desktopInstallFromRegistry() {
  try {
    const output = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "/s",
        "/f",
        "DSH Desktop",
        "/d",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 8000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines = output.split(/\r?\n/);
    let key = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("HKEY_")) key = trimmed;
      if (/InstallLocation\s+REG_SZ\s+(.+)/i.test(trimmed)) {
        const location = RegExp.$1.trim();
        if (location.length > 0) return location;
      }
    }
  } catch {
    /* registry unavailable — keep the candidate probe */
  }
  return undefined;
}

/**
 * The installed desktop app root: a directory holding the executable and the
 * unpacked runtime. Returns undefined when not found.
 */
export function locateDesktopInstall() {
  for (const candidate of desktopInstallCandidates()) {
    if (
      existsSync(join(candidate, DESKTOP_EXE_NAME)) &&
      existsSync(join(candidate, UNPACKED_REL, "package.json"))
    ) {
      return candidate;
    }
  }
  const fromRegistry = desktopInstallFromRegistry();
  if (
    fromRegistry !== undefined &&
    existsSync(join(fromRegistry, DESKTOP_EXE_NAME)) &&
    existsSync(join(fromRegistry, UNPACKED_REL, "package.json"))
  ) {
    return fromRegistry;
  }
  return undefined;
}

/** Absolute path of the desktop executable. */
export function desktopExePath(install = locateDesktopInstall()) {
  return install === undefined ? undefined : join(install, DESKTOP_EXE_NAME);
}

/** The unpacked runtime root (the desktop app's implementation checkout). */
export function unpackedRoot(install = locateDesktopInstall()) {
  return install === undefined ? undefined : join(install, UNPACKED_REL);
}

/** The desktop app's own package.json (the install anchor for bundle resolution). */
export function desktopInstallAnchor(install = locateDesktopInstall()) {
  const root = unpackedRoot(install);
  return root === undefined ? undefined : join(root, "package.json");
}

/** The packaged `dsh` CLI entry, runnable with plain system node. */
export function dshCliEntry(install = locateDesktopInstall()) {
  const root = unpackedRoot(install);
  return root === undefined ? undefined : join(root, DSH_CLI_REL);
}

/** The packaged `dsh-plugin-desktop` desktop bundle patch (its own layer). */
export function desktopBundlePatchPath(install = locateDesktopInstall()) {
  const root = unpackedRoot(install);
  return root === undefined ? undefined : join(root, "cordis.patch.yml");
}

/** Candidate desktop user-data directories, in probe order. */
function desktopUserDataCandidates() {
  const appData = process.env.APPDATA ?? "";
  return [
    join(appData, "DSH Desktop"),
    join(appData, "dsh-plugin-desktop"),
    join(appData, "DeepSeek Harness"),
  ];
}

/** The desktop user-data directory: the one holding profile-selection state. */
export function locateDesktopUserData() {
  for (const candidate of desktopUserDataCandidates()) {
    if (existsSync(join(candidate, "profile-selection", "state.json"))) return candidate;
  }
  // Fall back to the conventional first candidate even if state is missing.
  return desktopUserDataCandidates()[0];
}

/** profile-selection/state.json → { active, lastKnownGood } (or undefined). */
export function readProfileSelection(userData = locateDesktopUserData()) {
  const path = join(userData, "profile-selection", "state.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && typeof parsed.active === "string") {
      return {
        path,
        active: parsed.active,
        lastKnownGood: typeof parsed.lastKnownGood === "string" ? parsed.lastKnownGood : parsed.active,
      };
    }
  } catch {
    /* unreadable — caller handles */
  }
  return undefined;
}

/** plugin-management/state.json → { profiles: [{profileName, disabledBundles}] } (or undefined). */
export function readPluginManagement(userData = locateDesktopUserData()) {
  const path = join(userData, "plugin-management", "state.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.profiles)) {
      return {
        path,
        profiles: parsed.profiles.map((item) => ({
          profileName: String(item?.profileName ?? ""),
          disabledBundles: Array.isArray(item?.disabledBundles)
            ? item.disabledBundles.map((name) => String(name))
            : [],
        })),
      };
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/** Directory holding desktop logs. */
export function desktopLogsDir(userData = locateDesktopUserData()) {
  return join(userData, "logs");
}

/** Directory holding protected plugin-install recovery transactions. */
export function desktopInstallRecoveryDir(userData = locateDesktopUserData()) {
  return join(userData, "plugin-install-recovery");
}

/** Directory holding crash evidence from previous launches. */
export function desktopCrashEvidenceDir(userData = locateDesktopUserData()) {
  return join(userData, "crash-evidence");
}

/** The desktop single-instance lockfile. */
export function desktopLockfile(userData = locateDesktopUserData()) {
  return join(userData, "lockfile");
}

/**
 * Whether the desktop app is currently running: any live "DSH Desktop.exe"
 * process, or a fresh lockfile. Best-effort.
 */
export function isDesktopRunning() {
  return desktopPids().length > 0;
}

/**
 * PIDs of every live "DSH Desktop.exe" process (tasklist). Used to tell
 * whether a recorded launch PID is still the one that is running — i.e. to
 * detect that the user launched DSH directly (bypassing the manager) while an
 * isolated-run record is still pending.
 */
export function desktopPids() {
  try {
    const output = execFileSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${DESKTOP_EXE_NAME}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const pids = [];
    for (const line of output.split(/\r?\n/)) {
      // CSV row: "DSH Desktop.exe","12345","Console","1","123,456 K"
      const match = /^"[^"]*",\s*"(\d+)"/.exec(line.trim());
      if (match !== null) pids.push(Number(match[1]));
    }
    return pids;
  } catch {
    /* tasklist unavailable */
  }
  const lock = desktopLockfile();
  if (existsSync(lock)) {
    try {
      const stat = requireStat(lock);
      if (stat !== undefined && Date.now() - stat.mtimeMs < 60_000) return [0];
    } catch {
      /* ignore */
    }
  }
  return [];
}

/** tiny stat wrapper to keep this module ESM-clean */
function requireStat(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** System node executable (the manager runs on it). */
export function systemNode() {
  return process.execPath;
}

/** Node version triple of the running manager process. */
export function nodeVersion() {
  return process.versions.node;
}

/** A consolidated snapshot of everything discovered. */
export function probeEnvironment() {
  const home = resolveDshHome();
  const install = locateDesktopInstall();
  const userData = locateDesktopUserData();
  const selection = readProfileSelection(userData);
  const active = selection?.active ?? "desktop";
  const pluginManagement = readPluginManagement(userData);
  const disabledBundles = new Set(
    (pluginManagement?.profiles ?? []).find((item) => item.profileName === active)?.disabledBundles ?? [],
  );
  return {
    dshHome: home,
    profilesDir: profilesDir(home),
    activeProfile: active,
    lastKnownGood: selection?.lastKnownGood,
    selectionStatePath: selection?.path,
    install,
    desktopExe: desktopExePath(install),
    unpackedRoot: unpackedRoot(install),
    installAnchor: desktopInstallAnchor(install),
    dshCliEntry: dshCliEntry(install),
    desktopBundlePatchPath: desktopBundlePatchPath(install),
    userData,
    logsDir: desktopLogsDir(userData),
    installRecoveryDir: desktopInstallRecoveryDir(userData),
    crashEvidenceDir: desktopCrashEvidenceDir(userData),
    pluginManagementPath: pluginManagement?.path,
    desktopDisabledBundles: [...disabledBundles].sort(),
    desktopRunning: isDesktopRunning(),
    desktopPids: desktopPids(),
    systemNode: systemNode(),
    nodeVersion: nodeVersion(),
  };
}
