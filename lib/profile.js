/**
 * Kidai Plugin Remote — profile.js
 *
 * Profile discovery and patch-layer composition replicating `loadProfile` /
 * `composeEntries` from `@deepseek-ai/dsh-app-boot` and the desktop launcher's
 * `prepareDesktopProfile`, so the installed-plugin inventory and preflight
 * diagnostics match what actually boots:
 *
 *   layer order: bundle patches (in `dsh.profile.bundles` order)
 *               → profile's own cordis.patch.yml
 *               → home-level cordis.patch.yml
 *               → caller overlays (e.g. an isolation patch file)
 *
 * Bundle package resolution is two-anchor: the dsh installation first, then
 * the profile directory (identical to `resolveBundleDir`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  parsePatchFile,
  applyEntryPatches,
  homePatchPath,
  profilePatchPath,
} from "./patches.js";
import { resolveProfileDir } from "./dsh-env.js";

/** The profile manifest of one profile (empty shape on failure). */
export function readProfileManifest(profileDir) {
  try {
    // Strip a UTF-8 BOM if present — JSON.parse rejects it.
    return JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { dependencies: {}, dsh: {} };
  }
}

/** Ordered bundle list from a profile manifest. */
export function profileBundles(manifest) {
  return Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
}

/** Package directory from one resolution anchor (Node's own lookup order). */
export function packageDirFromAnchor(anchor, packageName) {
  let paths;
  try {
    paths = createRequire(anchor).resolve.paths(packageName) ?? [];
  } catch {
    paths = [];
  }
  for (const searchPath of paths) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

/**
 * Two-anchor bundle resolution: the dsh installation first, then the profile.
 * Throws the same message the real launcher uses when unresolvable.
 */
export function resolveBundleDir(packageName, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
    const dir = packageDirFromAnchor(anchor, packageName);
    if (dir !== undefined) return dir;
  }
  throw new Error(
    `cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; run 'dsh plugin --profile ${basenameSafe(profileDir)} install' if its dependency is not installed`,
  );
}

function basenameSafe(path) {
  return String(path).split(/[\\/]/).pop() ?? "";
}

/** Read a package manifest (null when unavailable). */
export function readPackageManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The declared bundle patch path (relative) of a package, or undefined. */
export function declaredBundlePatch(manifest) {
  const declared = manifest?.dsh?.bundle?.patch;
  return typeof declared === "string" && declared.length > 0 ? declared : undefined;
}

/** Creation time of a directory as ISO string ("" when unknown). */
export function installedAtOf(dir) {
  try {
    return new Date(statSync(dir).birthtime).toISOString();
  } catch {
    return "";
  }
}

/**
 * One resolved bundle layer:
 * `{ packageName, packageDir, patchPath, patches, mutable, disabled }`
 * `disabled` reflects the desktop plugin-management layer (whole-bundle skip).
 */
export function loadBundleLayer(packageName, installAnchor, profileDir, disabledBundleNames) {
  const packageDir = resolveBundleDir(packageName, installAnchor, profileDir);
  const manifest = readPackageManifest(packageDir);
  const declared = declaredBundlePatch(manifest);
  if (declared === undefined) {
    throw new Error(
      `profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`,
    );
  }
  const patchPath = join(packageDir, declared);
  return {
    packageName,
    packageDir,
    manifest,
    patchPath,
    patches: parsePatchFile(patchPath, { optional: false, label: "bundle overlay" }),
    mutable: isMutableBundle(packageName),
    disabled: disabledBundleNames.has(packageName),
  };
}

/** Bundles the desktop launcher considers immutable (its own product layers). */
export function isMutableBundle(packageName) {
  const immutable = new Set([
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-headless",
    "@deepseek-ai/dsh-desktop-app",
    "dsh-plugin-desktop",
    "dsh-community-market",
  ]);
  return typeof packageName === "string" && immutable.has(packageName) === false;
}

/**
 * Load the full layer stack of a profile.
 * @returns `{ profileDir, manifest, bundles, layers, profilePatch, homePatch }`
 * where `layers` are bundle layers and patches are the parsed row lists.
 */
export function loadProfileLayers(env, profileName, { skipDisabledBundles = true } = {}) {
  const profileDir = resolveProfileDir(profileName, env.dshHome);
  const manifest = readProfileManifest(profileDir);
  const bundleNames = profileBundles(manifest);
  const disabledBundles = new Set(env.desktopDisabledBundles ?? []);
  const layers = [];
  const layerProblems = [];
  for (const packageName of bundleNames) {
    if (skipDisabledBundles && isMutableBundle(packageName) && disabledBundles.has(packageName)) {
      continue; // desktop-private disable: the layer is skipped before any manifest read
    }
    try {
      layers.push(loadBundleLayer(packageName, env.installAnchor, profileDir, disabledBundles));
    } catch (error) {
      layerProblems.push({
        packageName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const profilePatch = profilePatchPath(profileDir);
  let profilePatches = [];
  let profilePatchProblem;
  try {
    const parsed = parsePatchFile(profilePatch, { optional: true, label: "profile patches" });
    if (parsed !== undefined) profilePatches = parsed;
  } catch (error) {
    profilePatchProblem = error instanceof Error ? error.message : String(error);
  }
  const homePatch = homePatchPath(env.dshHome);
  let homePatches = [];
  let homePatchProblem;
  try {
    const parsed = parsePatchFile(homePatch, { optional: true, label: "home patches" });
    if (parsed !== undefined) homePatches = parsed;
  } catch (error) {
    homePatchProblem = error instanceof Error ? error.message : String(error);
  }
  return {
    profileDir,
    manifest,
    bundleNames,
    layers,
    layerProblems,
    profilePatch,
    profilePatches,
    profilePatchProblem,
    homePatch,
    homePatches,
    homePatchProblem,
  };
}

/**
 * Desktop launcher overlay patches, replicating the row-adding part of
 * `prepareDesktopProfile` EXACTLY: only the desktop's own bundle patch
 * (`<install>/resources/app.asar.unpacked/cordis.patch.yml`) is injected —
 * the real desktop boot pushes nothing else into the row roster. Earlier
 * versions of this helper also fabricated win32 rows (desktop-windows-*,
 * desktop-directory-picker-browse-*, and disabled directory-picker /
 * pwsh-sandbox) that do NOT exist in the real desktop composition; toggling
 * those from the manager wrote dead `{id, disabled}` rows into the home patch
 * that DSH's loader could never match ("patch: entry … not found"), which is
 * exactly the "disabled plugins still enable" symptom. Config-only patches
 * (settings/webserver/desktop-shell config) are omitted — they do not change
 * the row roster the inventory/preflight cares about. `!!js` expressions stay
 * as parsed nodes (never evaluated).
 */
export function desktopOverlayPatches(env) {
  const patches = [];
  if (env.desktopBundlePatchPath !== undefined) {
    patches.push(...parsePatchFile(env.desktopBundlePatchPath, { optional: false, label: "desktop overlay" }));
  }
  return patches;
}

/**
 * Compose the effective entry list exactly like `composeEntries`:
 * every bundle layer's patches, then the profile layer, then the home layer,
 * then extra overlay layers, flattened and applied as ONE patch list over an
 * empty base.
 * @returns `{ rows, warnings, layerLabels }`
 */
export function composeProfile(layers, profilePatches, homePatches, extraLayers = []) {
  const layerLabels = [];
  const flat = [];
  for (const layer of layers) {
    flat.push(...layer.patches);
    layerLabels.push(`bundle:${layer.packageName}`);
  }
  if (profilePatches.length > 0) {
    flat.push(...profilePatches);
    layerLabels.push("profile:cordis.patch.yml");
  }
  if (homePatches.length > 0) {
    flat.push(...homePatches);
    layerLabels.push("home:cordis.patch.yml");
  }
  for (const [index, extra] of extraLayers.entries()) {
    flat.push(...extra);
    layerLabels.push(`overlay:${index}`);
  }
  const { rows, warnings } = applyEntryPatches([], flat);
  return { rows, warnings, layerLabels };
}

/**
 * All-in-one: load + compose a profile into rows (with per-file problems kept).
 * When `includeDesktopShell` is true, the desktop launcher overlay is injected
 * right after the `@deepseek-ai/dsh-web-app` bundle layer — exactly where
 * `prepareDesktopProfile` places it — so the desktop profile composes as the
 * real app boots it.
 */
export function composeProfileRows(
  env,
  profileName,
  { extraLayers = [], skipDisabledBundles = true, includeDesktopShell = false } = {},
) {
  const loaded = loadProfileLayers(env, profileName, { skipDisabledBundles });
  const bundleFlat = [];
  const layerLabels = [];
  let desktopOverlayProblem;
  for (const layer of loaded.layers) {
    bundleFlat.push(...layer.patches);
    layerLabels.push(`bundle:${layer.packageName}`);
    if (includeDesktopShell && layer.packageName === "@deepseek-ai/dsh-web-app") {
      try {
        bundleFlat.push(...desktopOverlayPatches(env));
        layerLabels.push("desktop:launcher-overlay");
      } catch (error) {
        desktopOverlayProblem = error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (loaded.profilePatches.length > 0) {
    bundleFlat.push(...loaded.profilePatches);
    layerLabels.push("profile:cordis.patch.yml");
  }
  if (loaded.homePatches.length > 0) {
    bundleFlat.push(...loaded.homePatches);
    layerLabels.push("home:cordis.patch.yml");
  }
  for (const [index, extra] of extraLayers.entries()) {
    bundleFlat.push(...extra);
    layerLabels.push(`overlay:${index}`);
  }
  const { rows, warnings } = applyEntryPatches([], bundleFlat);
  return { ...loaded, rows, warnings, layerLabels, desktopOverlayProblem };
}
