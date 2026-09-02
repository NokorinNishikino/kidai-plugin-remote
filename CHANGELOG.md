# Changelog

All notable changes to **Kidai Plugin Remote (纪代插件远程管理器)** are documented here.

## [Unreleased]

### Fixed

- **Snapshots are reusable after a rollback** — a snapshot that was used as a rollback target (status `rolled-back`) is again a valid rollback candidate for both the manager UI and `rollbackCandidates()`, so you can roll back to `A`, then to `B`, then back to `A` again; each rollback keeps its pre-rollback snapshot for reversibility.

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
