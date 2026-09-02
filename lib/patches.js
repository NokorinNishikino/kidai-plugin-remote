/**
 * Kidai Plugin Remote — patches.js
 *
 * Patch-layer handling with the EXACT dialect and merge semantics the DSH
 * boot uses (`@deepseek-ai/cordis-plugin-include`):
 *   - top-level YAML array of loader patch entries
 *   - `!!js` scalars round-trip as `{ __jsExpr }` expression nodes (parsed,
 *     never evaluated by the manager)
 *   - `insert` lists append rows (into a named group's config when `id` names
 *     a group), then are indexed so later patches in the same list can target
 *     them
 *   - id-targeted rows overwrite the target's fields (wholesale `config`
 *     replacement), with a `name` mismatch skipping the row
 *   - patches that match nothing are warnings, not errors
 *
 * Also implements the market's enable/disable write-back (merge `{id,
 * disabled}` into the HOME-level patch layer) plus timestamped backups.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import * as YAML from "../vendor/yaml/dist/index.js";

/** `!!js` scalar tag: parses to `{ __jsExpr }`, serializes back to `!!js`. */
const jsExprTag = {
  tag: "tag:yaml.org,2002:js",
  default: false,
  resolve: (value) => ({ __jsExpr: value }),
  identify: (value) =>
    value !== null && typeof value === "object" && typeof value.__jsExpr === "string",
  stringify: ({ value }) => String(value.__jsExpr),
};

const YAML_PARSE_OPTIONS = { customTags: [jsExprTag] };
const YAML_STRINGIFY_OPTIONS = { customTags: [jsExprTag] };

/** Parse one patch-list document (YAML array of rows); throws descriptive errors. */
export function parsePatchText(content, file, label) {
  let parsed;
  try {
    // Strip a UTF-8 BOM if present — some editors/tools write one and the
    // YAML parser rejects it at the first scalar.
    const clean = String(content).replace(/^\uFEFF/, "");
    parsed = YAML.parse(clean, YAML_PARSE_OPTIONS);
  } catch (error) {
    throw new Error(`failed to parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === undefined || parsed === null) {
    // An empty or comment-only patch file is a boot error upstream; mirror it.
    throw new Error(`${label} ${file} is empty (parse result is empty rather than a list)`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} ${file} must be a top-level YAML array of loader patch entries`);
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
    }
  });
  return parsed;
}

/** Read a patch-list file. `optional` files (the home/profile layer) return undefined when absent. */
export function parsePatchFile(file, { optional = false, label = "patches" } = {}) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    throw new Error(`failed to read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsePatchText(content, file, label);
}

/** Serialize a rows array back to the same YAML dialect. */
export function stringifyRows(rows) {
  return YAML.stringify(rows, YAML_STRINGIFY_OPTIONS);
}

/**
 * Faithful clone of the include plugin's `applyEntryPatches` over a base row
 * list. `data` is cloned; patches are applied in order.
 * @returns `{ rows, warnings }` — warnings mirror the boot-time loader warnings.
 */
export function applyEntryPatches(data, patches) {
  const rows = structuredClone(data);
  const warnings = [];
  if (!Array.isArray(patches) || patches.length === 0) return { rows, warnings };

  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry && typeof entry.id === "string") entryMap.set(entry.id, entry);
      if (entry && entry.group === true && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(rows);

  const warn = (message, ...args) => {
    warnings.push(message.replace(/%C/g, () => JSON.stringify(args.shift())));
  };

  for (const patch of patches) {
    if (patch === null || typeof patch !== "object") continue;
    const { id, insert, name, ...overrides } = patch;

    if (insert !== undefined) {
      const insertList = Array.isArray(insert) ? insert : [insert];
      if (id) {
        const target = entryMap.get(id);
        if (!target) {
          warn("patch insert: entry %C not found", id);
          continue;
        }
        if (target.group !== true) {
          warn("patch insert: entry %C is not a group", id);
          continue;
        }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insertList);
      } else {
        rows.push(...insertList);
      }
      buildMap(insertList);
      continue;
    }

    if (!id) {
      warn("patch: id is required for non-insert patches");
      continue;
    }
    const target = entryMap.get(id);
    if (!target) {
      warn("patch: entry %C not found", id);
      continue;
    }
    if (name && name !== target.name) {
      warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = value;
    }
  }
  return { rows, warnings };
}

/** Compose one flat patch list over an empty entry list (same as `composeEntries`). */
export function composeFromPatches(layers) {
  return applyEntryPatches([], layers.flat());
}

/** Home-level patch path under the Harness home. */
export function homePatchPath(home) {
  return join(home, "cordis.patch.yml");
}

/** Profile-level patch path. */
export function profilePatchPath(profileDir) {
  return join(profileDir, "cordis.patch.yml");
}

/** Read the home-level patch list (undefined when absent). */
export function readHomePatch(home) {
  return parsePatchFile(homePatchPath(home), { optional: true, label: "home patches" });
}

/** Backup root kept by the manager inside the Harness home. */
export function backupRoot(home) {
  return join(home, ".kidai-remote-backups");
}

/** Rolling snapshot: copy `path` into the backup root (keep `keep` newest).
 *  A missing source is fine to skip (nothing to preserve before an overwrite),
 *  mirroring {@link backupDirectory} — so a restore of a missing file does not
 *  fail just because there was nothing to back up. */
export function backupFile(home, path, tag) {
  const source = String(path);
  if (!existsSync(source)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = join(backupRoot(home), `${stamp}-${tag}`);
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, source.split(/[\\/]/).pop() || "state.bin");
  try {
    writeFileSync(target, readFileSync(source));
  } catch (error) {
    throw new Error(`failed to back up ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  pruneBackups(home, 20);
  return target;
}

/** Rolling snapshot of a DIRECTORY (recursive copy) into the backup root. */
export function backupDirectory(home, dir, tag) {
  const source = String(dir);
  // A missing source is fine to back up (restore scenarios often deleted it).
  if (!existsSync(source)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = join(backupRoot(home), `${stamp}-${tag}`);
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, source.split(/[\\/]/).pop() || "dir");
  try {
    cpSync(source, target, { recursive: true });
  } catch (error) {
    throw new Error(`failed to back up directory ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  pruneBackups(home, 20);
  return target;
}

/** Keep only the newest `keep` snapshots under the backup root. */
function pruneBackups(home, keep) {
  try {
    const root = backupRoot(home);
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const old of entries.slice(keep)) rmSync(old, { recursive: true, force: true });
  } catch {
    /* backup pruning is best-effort */
  }
}

/** Restore the most recent snapshot of `path` under `tag` prefix (or a given snapshot dir). */
export function restoreLatestBackup(home, path, tag) {
  const root = backupRoot(home);
  if (!existsSync(root)) return false;
  const name = String(path).split(/[\\/]/).pop() || "state.bin";
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(`-${tag}`))
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const dir of dirs) {
    const snapshot = join(dir, name);
    if (existsSync(snapshot)) {
      writeFileSync(String(path), readFileSync(snapshot));
      return true;
    }
  }
  return false;
}

/**
 * Enable/disable one loader entry by merging `{ id, disabled }` into the
 * HOME-level patch layer — the exact same write the market's `setEnabled`
 * performs, so both tools stay consistent. Backs up first.
 * @returns a market-shaped result object.
 */
export function setEnabledRow(home, rowId, enabled) {
  if (typeof rowId !== "string" || rowId.trim().length === 0) {
    return { ok: false, rowId: String(rowId ?? ""), enabled: enabled === true, message: "invalid plugin id", restartNeeded: false };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(rowId)) {
    return { ok: false, rowId, enabled: enabled === true, message: "invalid plugin id", restartNeeded: false };
  }
  const path = homePatchPath(home);
  let doc = [];
  try {
    const parsed = parsePatchFile(path, { optional: true, label: "home patches" });
    if (parsed !== undefined) doc = parsed;
  } catch (error) {
    return {
      ok: false,
      rowId,
      enabled: enabled === true,
      message: `home patch layer is broken: ${error instanceof Error ? error.message : String(error)}`,
      restartNeeded: false,
    };
  }
  const target = enabled === true ? false : true;
  const index = doc.findIndex(
    (row) => row !== null && typeof row === "object" && !Array.isArray(row) && row.id === rowId && row.insert === undefined,
  );
  try {
    backupFile(home, path, "toggle");
  } catch {
    /* a failed backup must not block the toggle */
  }
  const row = { id: rowId, disabled: target };
  if (index >= 0) doc[index] = { ...doc[index], disabled: target };
  else doc.push(row);
  try {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, stringifyRows(doc));
    renameSync(tmp, path);
  } catch (error) {
    return {
      ok: false,
      rowId,
      enabled: enabled === true,
      message: `failed to write home patch layer: ${error instanceof Error ? error.message : String(error)}`,
      restartNeeded: false,
    };
  }
  return {
    ok: true,
    rowId,
    enabled: enabled === true,
    path,
    restartNeeded: true,
    message: `已${enabled === true ? "启用" : "停用"}「${rowId}」\n配置文件：${path}\n重启 DSH 后生效。`,
  };
}

/** Write an arbitrary rows array to a patch file atomically. */
export function writePatchFile(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, stringifyRows(rows));
  renameSync(tmp, path);
}
