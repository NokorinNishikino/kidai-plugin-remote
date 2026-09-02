# Changelog

All notable changes to **Kidai Plugin Remote (纪代插件远程管理器)** are documented here.

## [1.3.4] - 2026-09-02

### Fixed

- **Snapshots are reusable after a rollback** — a snapshot that was used as a rollback target (status `rolled-back`) is again a valid rollback candidate for both the manager UI and `rollbackCandidates()`, so you can roll back to `A`, then to `B`, then back to `A` again; each rollback keeps its pre-rollback snapshot for reversibility.

### Performance

- `probeEnvironment()` now computes the running desktop PIDs once (previously twice) and the `tasklist` probe is TTL-cached, so the 2s UI heartbeat and bursted `/api` calls no longer each spawn `tasklist`.
- Static asset requests are served without probing the environment.
- The snapshot `size` is stored in the snapshot meta at creation and read directly by `listSnapshots()` instead of recursively walking every snapshot directory on each list.
- The activity-log poll is slowed from 3s to 5s.

## [1.2.7] - 2026-09-02

### Added

- **Full-environment restore** — `importFullEnvironmentZip()` + `/api/env-restore` route + 「♻ 恢复完整环境」button. Extracts the `dsh/` tree into the Harness home (config + offline packages), the `desktop/` tree into the desktop user-data dir (profile-selection / plugin-management), and rebuilds recorded junction/symlink entries. Current files are backed up first so the restore is reversible.

### Fixed

- **Zip-slip (path traversal)** — `importZipAndRestore()` and `importFullEnvironmentZip()` now strictly sanitize untrusted zip entry names (reject `..`, backslashes and absolute segments), so a crafted backup can no longer write outside `node_modules` / `home` / the desktop user-data dir, or create arbitrary symlinks via `links.json`.
- **Import could not restore config files** — `importZipAndRestore()` used the undefined `pathDirname` (now `dirname`), which threw for every config entry and meant "导入 zip 恢复" only restored package directories.
- **`backupFile` aborted on a missing source** — a restore/rollback to a state where the target file is absent (common after a crash) no longer fails; a missing source is skipped so the restore still proceeds.
- **Scoped package names** — `importZipAndRestore()` resolves scoped package names (`@scope/demo`) via the manifest's `packages` map and restores them to the correct `node_modules/@scope/demo` path.
- **Format validation** — `importZipAndRestore()` rejects zips whose manifest `format` is not `kidai-snapshot`.

## [1.2.6] - 2026-08-22

- Initial published release.
