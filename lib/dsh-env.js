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
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
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
/**
 * Path of the DSH Desktop packaged CLI bootstrap, relative to the install root.
 * Desktop 2.x ships the CLI INSIDE `app.asar` (there is no
 * `app.asar.unpacked/node_modules/@deepseek-ai/dsh`); the app's own host-command
 * shim runs it as
 *   `"DSH Desktop.exe" --expose-internals <app.asar>\lib\desktop-cli.js`
 * with `ELECTRON_RUN_AS_NODE=1`.
 */
const DSH_CLI_BOOTSTRAP_REL = join("resources", "app.asar", "lib", "desktop-cli.js");
/** Packaged `dsh` CLI bootstrap under a supplied app.asar.unpacked root. */
const DSH_CLI_UNPACKED_REL = join("@deepseek-ai", "dsh", "lib", "bin.js");

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
  const fromRegistry = desktopInstallFromRegistry();
  if (fromRegistry !== undefined) list.push(fromRegistry);
  list.push(join(process.env.LOCALAPPDATA ?? "", "Programs", DESKTOP_APP_DIRNAME));
  list.push(join(process.env.PROGRAMFILES ?? "", DESKTOP_APP_DIRNAME));
  list.push(join(process.env["PROGRAMFILES(X86)"] ?? "", DESKTOP_APP_DIRNAME));
  list.push(join(process.env.APPDATA ?? "", DESKTOP_APP_DIRNAME));
  return list;
}

/**
 * Whether a candidate directory is a DSH Desktop install root.
 *
 * Desktop 2.x ships NO `resources\app.asar.unpacked\package.json` (the unpacked
 * dir only carries native modules), so the executable plus the resources
 * directory is the install signature. A single-file (`$DSH_DESKTOP_EXE`) or
 * partially unpacked install is accepted as well.
 */
function isDesktopInstall(dir) {
  if (dir === "" || !existsSync(join(dir, DESKTOP_EXE_NAME))) return false;
  return (
    existsSync(join(dir, "resources")) ||
    existsSync(join(dir, UNPACKED_REL)) ||
    existsSync(join(dir, DSH_CLI_BOOTSTRAP_REL))
  );
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
    if (candidate !== "" && isDesktopInstall(candidate)) return candidate;
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

/**
 * The packaged `dsh` CLI command.
 *
 * Desktop 2.x keeps the CLI inside `app.asar` and runs it through the desktop
 * executable in ELECTRON_RUN_AS_NODE mode, so the command is an executable plus
 * an argument list rather than a bare script path. Older/unpacked installs
 * provide a runnable `bin.js`, which is returned as a single `script` argument
 * for a plain Node runtime.
 *
 * @returns `{ run, args, kind }` or undefined when the install carries no CLI.
 */
export function resolveDshCliCommand(install = locateDesktopInstall()) {
  if (install === undefined) return undefined;
  const exe = join(install, DESKTOP_EXE_NAME);
  if (!existsSync(exe)) return undefined;
  // 1) Desktop 2.x packaged bootstrap. Its path lives INSIDE `app.asar`, which
  //    a plain Node `existsSync` cannot see (only Electron's patched fs can), so
  //    the archive itself is the evidence; the spawn then goes through the
  //    desktop executable, whose patched fs resolves the path for real.
  const bootstrap = join(install, DSH_CLI_BOOTSTRAP_REL);
  if (existsSync(bootstrap) || existsSync(join(install, "resources", "app.asar"))) {
    return { run: exe, args: [bootstrap], kind: "desktop-bootstrap" };
  }
  // 2) Unpacked runtime carrying the classic CLI entry.
  const legacy = join(install, UNPACKED_REL, DSH_CLI_REL);
  if (existsSync(legacy)) {
    return { run: exe, args: [legacy], kind: "unpacked-cli" };
  }
  // 3) The app's own host-command shim (its hash directory is generation-scoped),
  //    which pins the real bootstrap path.
  const fromShim = cliBootstrapFromHostCommandShim(install);
  if (fromShim !== undefined && existsSync(fromShim)) {
    return { run: exe, args: [fromShim], kind: "shim-bootstrap" };
  }
  return undefined;
}

/** Absolute path of the packaged CLI entry (informational / compatibility). */
export function dshCliEntry(install = locateDesktopInstall()) {
  const command = resolveDshCliCommand(install);
  return command === undefined ? undefined : command.args[0];
}

/** Newest DSH Desktop host-command shim, which pins the packaged CLI bootstrap. */
function cliBootstrapFromHostCommandShim(install = locateDesktopInstall()) {
  if (install === undefined) return undefined;
  const appData = process.env.APPDATA ?? "";
  if (appData === "") return undefined;
  const roots = [join(appData, "DSH Desktop", "host-commands")];
  const profile = process.env.DSH_PROFILE;
  if (typeof profile === "string" && profile.trim().length > 0) {
    roots.push(join(appData, "DSH Desktop", "host-commands", profile.trim()));
  }
  let newest;
  let newestAt = -1;
  for (const root of roots) {
    let profiles;
    try {
      profiles = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue;
      const generations = join(root, entry.name, "generations");
      let rows;
      try {
        rows = readdirSync(generations, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const row of rows) {
        if (!row.isDirectory()) continue;
        const dir = join(generations, row.name);
        let at = 0;
        try {
          at = statSync(dir).mtimeMs;
        } catch {
          /* ignore */
        }
        if (newestAt !== -1 && at <= newestAt) continue;
        const shim = parseCliShim(join(dir, "bin", "dsh.cmd"));
        if (shim !== undefined) {
          newest = shim;
          newestAt = at;
        }
      }
    }
  }
  return newest;
}

/** Extract the bootstrap JS path out of a `bin\dsh.cmd` shim, if it pins one. */
function parseCliShim(shimPath) {
  try {
    const text = readFileSync(shimPath, "utf8");
    const match = /--expose-internals["'\s]+"([^"]+\.(?:js|mjs|cjs))"/i.exec(text);
    return match === null ? undefined : match[1];
  } catch {
    return undefined;
  }
}

/** The packaged `dsh-plugin-desktop` desktop bundle patch (its own layer). */
export function desktopBundlePatchPath(install = locateDesktopInstall()) {
  const root = unpackedRoot(install);
  return root === undefined ? undefined : join(root, "cordis.patch.yml");
}

/** Absolute path of the desktop's bundle patch inside `app.asar`. */
export function desktopBundlePatchAsarPath(install = locateDesktopInstall()) {
  return install === undefined ? undefined : join(install, "resources", "app.asar");
}

/**
 * Whether a packaged desktop layer is readable at `path`.
 *
 * Desktop 2.x ships `cordis.patch.yml` INSIDE `resources\app.asar` (the unpacked
 * dir only carries native modules), so `existsSync` is false for a path that is
 * perfectly readable once the archive is parsed.
 */
export function isDesktopPatchReadable(path) {
  if (path === undefined) return false;
  if (existsSync(path)) return true;
  const marker = join("app.asar", "cordis.patch.yml");
  if (!path.endsWith(marker)) return false;
  const asar = path.slice(0, path.length - "cordis.patch.yml".length - 1); // keep ...\app.asar
  return existsSync(asar);
}

/**
 * Read a UTF-8 text file that may live inside an Electron `app.asar` archive.
 * Returns undefined when the file is missing or the archive is malformed.
 */
export function readAsarText(asarPath, relPath) {
  let fd;
  try {
    fd = openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return undefined;
    const jsonLength = head.readUInt32LE(4);
    if (jsonLength <= 0) return undefined;
    const headerBytes = Buffer.alloc(jsonLength);
    readSync(fd, headerBytes, 0, jsonLength, 16);
    const header = JSON.parse(headerBytes.toString("utf8"));
    // asar nests directory entries as `{ files: {...} }`, so each path segment
    // descends through `.files` (`files.node_modules.files["@scope"].files[name]`).
    let entry = header;
    for (const part of relPath.split(/[\\/]/)) {
      if (entry === null || typeof entry !== "object") return undefined;
      const children = entry.files;
      if (children === null || typeof children !== "object") return undefined;
      entry = children[part];
    }
    if (entry === null || typeof entry !== "object" || entry.size === undefined || entry.offset === undefined) return undefined;
    const size = Number(entry.size);
    const offset = Number(entry.offset);
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size < 0) return undefined;
    const data = Buffer.alloc(size);
    // Pickled asar header: 8 bytes of framing + the JSON + 8 bytes of padding.
    readSync(fd, data, 0, size, 16 + jsonLength - 8 + offset);
    return data.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The desktop bundle patch text, from the unpacked dir or from inside app.asar. */
export function readDesktopBundlePatchText(env) {
  const path = env?.desktopBundlePatchPath;
  if (path !== undefined && existsSync(path)) {
    return { text: readFileSync(path, "utf8"), source: path };
  }
  const asarPath = desktopBundlePatchAsarPath(env?.install);
  if (asarPath !== undefined && existsSync(asarPath)) {
    const text = readAsarText(asarPath, "cordis.patch.yml");
    if (text !== undefined) return { text, source: `${asarPath}\u0000cordis.patch.yml` };
  }
  return undefined;
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
 * isolated-run record is still pending. Falls back to the single-instance
 * lockfile (PID 0 = "running, pid unknown") when tasklist cannot be used.
 */
export function desktopPids() {
  if (cachedPids.value !== undefined && Date.now() - cachedPids.at < PIDS_TTL_MS) return cachedPids.value;
  const value = probeDesktopPids();
  cachedPids = { at: Date.now(), value };
  return value;
}

/** Tasklist probe (cached with a short TTL by {@link desktopPids}). */
function probeDesktopPids() {
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
    /* tasklist unavailable (for example blocked by a sandbox) — use the lockfile */
  }
  const lock = desktopLockfile();
  if (existsSync(lock)) {
    // A running DSH Desktop holds its single-instance lockfile open, which is a
    // far stronger signal than its mtime: the file is written once at startup
    // and never touched again, so a freshness window would only ever cover the
    // first minute of a long-running app.
    if (probeLockfileHeld(lock)) return [0];
    try {
      const stat = requireStat(lock);
      if (stat !== undefined && Date.now() - stat.mtimeMs < 60_000) return [0];
    } catch {
      /* ignore */
    }
  }
  return [];
}

/**
 * Whether another process holds the lockfile open. Probing with an exclusive
 * open works in read-only environments too (no directory write required).
 */
function probeLockfileHeld(path) {
  let handle;
  try {
    handle = openSync(path, "r+");
    return false; // opened exclusively ⇒ nothing holds it
  } catch (error) {
    const code = error?.code;
    // EPERM/EACCES/EBUSY/ETXTBSY: denied because the file is in use.
    return code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "ETXTBSY";
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Short cache so the 2s UI heartbeat and bursted /api calls do not each
 *  spawn `tasklist` independently. */
let cachedPids = { at: 0, value: undefined };
const PIDS_TTL_MS = 1200;

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
  // Compute the (cached) desktop PIDs once and derive running from it, so a
  // single probeEnvironment does not spawn `tasklist` twice.
  const runningPids = desktopPids();
  const cliCommand = resolveDshCliCommand(install);
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
    dshCliEntry: cliCommand === undefined ? undefined : cliCommand.args[0],
    dshCliKind: cliCommand?.kind,
    desktopBundlePatchPath: desktopBundlePatchPath(install),
    userData,
    logsDir: desktopLogsDir(userData),
    installRecoveryDir: desktopInstallRecoveryDir(userData),
    crashEvidenceDir: desktopCrashEvidenceDir(userData),
    pluginManagementPath: pluginManagement?.path,
    desktopDisabledBundles: [...disabledBundles].sort(),
    desktopRunning: runningPids.length > 0,
    desktopPids: runningPids,
    systemNode: systemNode(),
    nodeVersion: nodeVersion(),
  };
}
