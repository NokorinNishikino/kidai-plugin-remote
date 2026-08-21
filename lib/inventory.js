/**
 * Kidai Plugin Remote — inventory.js
 *
 * The installed-plugin list, produced the same way the Kidai Plugin Market's
 * `installed()`/`thirdPartyPlugins()` build it — but purely from disk:
 * composed loader rows (bundle patches + profile/home patch layers), tagged
 * native vs third-party by the `@deepseek-ai/` prefix, with description,
 * version, install time, and the local package path for the card UI.
 */
import { dirname, join } from "node:path";
import { packageDirFromAnchor, readPackageManifest, installedAtOf } from "./profile.js";
import { packageEntryExists } from "./plugin-mgmt.js";

/** Row ids the launcher owns and never surfaces as user plugins. */
const INTERNAL_IDS = new Set(["include", "group"]);
const INTERNAL_NAME_PREFIXES = ["cordis:", "dsh-plugin-desktop"];

function isInternalRow(row) {
  if (row === null || typeof row !== "object") return true;
  if (typeof row.id === "string" && INTERNAL_IDS.has(row.id)) return true;
  if (typeof row.name === "string") {
    for (const prefix of INTERNAL_NAME_PREFIXES) if (row.name === prefix || row.name.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Strip a subpath specifier down to the npm package name. */
function basePackageName(specifier) {
  const parts = String(specifier).split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? specifier;
}

/** Resolve a package's on-disk directory from the profile anchor. */
export function resolvePackageDir(profileDir, specifier) {
  const base = basePackageName(specifier);
  const dir = packageDirFromAnchor(join(profileDir, "package.json"), base);
  return dir !== undefined ? dir : join(profileDir, "node_modules", base);
}

/** Deterministic avatar color for rows without a catalog icon. */
export function letterColor(name) {
  const colors = ["#5b8def", "#7c6fe0", "#4fb3a6", "#e0963f", "#d96f8b", "#6aa84f", "#a97bd0", "#5aa7c8"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length];
}

/**
 * Build the installed view for a profile from a composed profile snapshot.
 * @param env - probeEnvironment() snapshot.
 * @param profileName - profile to inspect.
 * @param composed - output of composeProfileRows().
 * @returns the installed view (market-shaped).
 */
export function buildInstalledView(env, profileName, composed) {
  const manifest = composed.manifest ?? { dependencies: {}, dsh: {} };
  const rows = [];
  const seen = new Set();
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.name !== "string" || seen.has(row.name)) continue;
    if (isInternalRow(row)) continue;
    seen.add(row.name);
    const path = resolvePackageDir(composed.profileDir, row.name);
    const pkg = readPackageManifest(path);
    const thirdParty = row.name.startsWith("@deepseek-ai/") === false;
    rows.push({
      entryId: typeof row.id === "string" ? row.id : "",
      name: row.name,
      enabled: row.disabled !== true,
      origin: thirdParty ? "third-party" : "native",
      description: typeof pkg?.description === "string" ? pkg.description : "",
      version: typeof pkg?.version === "string" ? pkg.version : "",
      installedAt: installedAtOf(path),
      path,
      // Entry validation (hub 1.3.4): a dsh.bundle package with no loadable
      // entry would fail the whole boot (misakanet mode).
      entryOk: pkg === null ? true : packageEntryExists(path, pkg),
      entryWarn: thirdParty && pkg !== null && pkg?.dsh?.bundle !== undefined && !packageEntryExists(path, pkg),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const bundles = (composed.bundleNames ?? []).map((packageName) => {
    const layer = (composed.layers ?? []).find((candidate) => candidate.packageName === packageName);
    const problem = (composed.layerProblems ?? []).find((candidate) => candidate.packageName === packageName);
    return {
      packageName,
      mutable: layer?.mutable ?? true,
      disabled: layer?.disabled ?? false,
      resolved: layer !== undefined,
      path: layer?.packageDir,
      patchPath: layer?.patchPath,
      problem: problem?.message,
    };
  });

  return {
    dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
    bundles,
    plugins: rows,
    profileDir: composed.profileDir,
    profileName,
    restartSupported: false,
    homePatchProblem: composed.homePatchProblem,
    profilePatchProblem: composed.profilePatchProblem,
    thirdPartyCount: rows.filter((row) => row.origin !== "native").length,
  };
}
