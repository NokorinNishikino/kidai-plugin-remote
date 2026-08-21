/**
 * Kidai Plugin Remote — foreign-backups.js
 *
 * Reads the backup/snapshot stores of OTHER tools so the manager can show and
 * restore them:
 *
 *   - dsh-plugin-guard: `$DSH_HOME/rollbacks/<profile>/<stamp>/` — manifest.json
 *     + 5 config files (package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
 *     cordis.yml, cordis.patch.yml). Restore copies those files back.
 *   - dsh-config-manager: `$DSH_HOME/dsh-config-manager/snapshots/<uuid>/` —
 *     snapshot.json with `hostFileBackups` (`relPath` relative to DSH_HOME +
 *     blobPath under blobs/host/). Restore copies blobs back to their paths.
 *   - dsh-config-manager exports: `$DSH_HOME/dsh-config-manager/exports/*.zip`
 *     (full config exports; listed read-only — import through config-manager).
 *
 * Every restore first takes a KPR snapshot of the current state so the
 * foreign restore itself is reversible.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { backupFile } from "./patches.js";
import { createSnapshot } from "./snapshots.js";

const GUARD_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];

function guardRoot(env, profileName) {
  return join(env.dshHome, "rollbacks", profileName);
}

function configManagerSnapshotsRoot(env) {
  return join(env.dshHome, "dsh-config-manager", "snapshots");
}

function configManagerExportsRoot(env) {
  return join(env.dshHome, "dsh-config-manager", "exports");
}

/** List foreign backup stores (readable / restorable / read-only exports). */
export function listForeignBackups(env, profileName) {
  const guard = [];
  try {
    const root = guardRoot(env, profileName);
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(root, entry.name, "manifest.json");
        let manifest = {};
        let createdAt = "";
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8")) ?? {};
          createdAt = typeof manifest.time === "string" ? manifest.time : "";
        } catch {
          /* manifest unreadable — fall back to dir mtime */
        }
        if (createdAt === "") {
          try {
            createdAt = new Date(statSync(join(root, entry.name)).mtime).toISOString();
          } catch {
            /* ignore */
          }
        }
        guard.push({
          source: "dsh-plugin-guard",
          id: entry.name,
          dir: join(root, entry.name),
          createdAt,
          tag: String(manifest.tag ?? ""),
          reason: String(manifest.reason ?? ""),
          files: Array.isArray(manifest.files) ? manifest.files : GUARD_FILES,
          profile: String(manifest.profile ?? profileName),
        });
      }
    }
  } catch {
    /* unreadable */
  }
  guard.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const configManager = [];
  try {
    const root = configManagerSnapshotsRoot(env);
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(root, entry.name, "snapshot.json");
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) ?? {};
          const hostFiles = Array.isArray(manifest.hostFileBackups) ? manifest.hostFileBackups : [];
          configManager.push({
            source: "dsh-config-manager",
            id: String(manifest.id ?? entry.name),
            dir: join(root, entry.name),
            createdAt: String(manifest.createdAt ?? ""),
            status: String(manifest.status ?? "unknown"),
            hostFiles: hostFiles.length,
            restorableFiles: hostFiles.filter((item) => typeof item?.blobPath === "string" && item.blobPath.length > 0 && item.existed !== false).length,
            entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
          });
        } catch {
          /* skip unreadable snapshots */
        }
      }
    }
  } catch {
    /* unreadable */
  }
  configManager.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const configManagerExports = [];
  try {
    const root = configManagerExportsRoot(env);
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
        let mtime = "";
        let size = 0;
        try {
          const stat = statSync(join(root, entry.name));
          mtime = new Date(stat.mtime).toISOString();
          size = stat.size;
        } catch {
          /* ignore */
        }
        configManagerExports.push({
          source: "dsh-config-manager-export",
          id: entry.name,
          path: join(root, entry.name),
          createdAt: mtime,
          size,
          restorable: false,
        });
      }
    }
  } catch {
    /* unreadable */
  }
  configManagerExports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return { guard, configManager, configManagerExports };
}

/** Restore one foreign backup. KPR snapshots the current state first. */
export function restoreForeignBackup(env, profileName, composed, { source, id }) {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, message: "缺少备份 id" };
  }
  const profileDir = composed?.profileDir ?? join(env.dshHome, "profiles", profileName);
  const restored = [];
  const failed = [];

  // Reversible: snapshot the current state before any foreign restore.
  try {
    createSnapshot(env, profileName, composed, {
      trigger: "rollback",
      note: `使用外部备份回滚前（来源 ${source}，${id}）`,
    });
  } catch {
    /* a failed pre-restore snapshot does not block the restore */
  }

  const restoreFile = (sourcePath, targetPath, label) => {
    if (!existsSync(sourcePath)) {
      failed.push(`${label}: 备份文件不存在 ${sourcePath}`);
      return;
    }
    try {
      backupFile(env.dshHome, targetPath, "foreign");
      copyFileSync(sourcePath, targetPath);
      restored.push(targetPath);
    } catch (error) {
      failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (source === "dsh-plugin-guard") {
    const snapDir = join(guardRoot(env, profileName), id);
    if (!existsSync(snapDir)) return { ok: false, message: `guard 备份不存在：${snapDir}` };
    for (const file of GUARD_FILES) {
      restoreFile(join(snapDir, file), join(profileDir, file), file);
    }
  } else if (source === "dsh-config-manager") {
    const snapDir = join(configManagerSnapshotsRoot(env), id);
    const manifestPath = join(snapDir, "snapshot.json");
    if (!existsSync(manifestPath)) return { ok: false, message: `config-manager 备份不存在：${snapDir}` };
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) ?? {};
    } catch (error) {
      return { ok: false, message: `config-manager 备份清单无法解析：${error instanceof Error ? error.message : String(error)}` };
    }
    const hostFiles = Array.isArray(manifest.hostFileBackups) ? manifest.hostFileBackups : [];
    for (const item of hostFiles) {
      if (item === null || typeof item !== "object") continue;
      const relPath = typeof item.relPath === "string" ? item.relPath : "";
      const blobPath = typeof item.blobPath === "string" ? item.blobPath : "";
      if (relPath === "" || blobPath === "" || item.existed === false) continue;
      restoreFile(join(snapDir, blobPath), join(env.dshHome, ...relPath.split(/[\\/]/)), relPath);
    }
  } else {
    return { ok: false, message: `不支持的回滚来源：${source}` };
  }

  return {
    ok: failed.length === 0,
    message:
      failed.length === 0
        ? `已用 ${source} 备份「${id}」回滚：恢复 ${restored.length} 项。\n重启 DSH 后生效。`
        : `回滚不完整：恢复 ${restored.length} 项，失败 ${failed.length} 项：\n${failed.join("\n")}`,
    restored: restored.length,
    failed: failed.length,
    source,
    id,
  };
}
