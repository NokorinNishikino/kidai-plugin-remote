# Kidai Plugin Remote

A **standalone** plugin manager that runs completely outside DSH and DSH
Desktop: it lists the installed DSH plugins the same way the Kidai Plugin
Market does, toggles them, launches DSH Desktop with the selected plugin set,
offers an isolated native-only run, and reports startup failures with conflict
analysis and fix hints. No network marketplace — no DSH runtime required
(besides Node.js ≥ 20 on the machine).

Built because restart-verification during Kidai market development repeatedly
ended with "DSH won't open again": broken bundle lists, missing dependencies,
and self-referencing `file:./node_modules/...` dependencies all fail at boot —
when DSH itself can no longer start. This manager is the external rescue /
daily-management tool for exactly that moment.

## Features

- **Installed plugin list** — composed the same way the market does it:
  profile manifest `dsh.profile.bundles` → each bundle's `cordis.patch.yml` →
  profile-level and home-level patch layers → the desktop launcher overlay,
  producing the real loader entry tree with native/third-party, enabled state,
  version, path, install time.
- **Sort / filter / views / force refresh** — by name/status/time, type
  (third-party/native), status (enabled/disabled), keyword; wide/narrow rows.
- **Enable / disable** — identical to the market's `setEnabled`: merge
  `{id, disabled}` into `$DSH_HOME/cordis.patch.yml` with an automatic backup;
  takes effect after restart (or live via HMR while DSH runs).
- **Launch DSH Desktop** with the current selection, after an automatic
  composition preflight.
- **Isolated run** — disables ALL third-party plugins for this run: both the
  desktop-private `plugin-management/state.json` (whole-bundle skip, works even
  for broken packages) and entry-level home-patch rows; native DSH only. The
  original configuration is **auto-restored when DSH exits** (or via
  "结束隔离" manually).
- **Success → auto-minimize** — detects DSH's own health-commit
  (profile-selection active == lastKnownGood), minimizes the manager console
  and collapses the page to a background monitor strip.
- **Failure → diagnostic report** — exit code, stderr, desktop log excerpts,
  crash dumps, selection-state rollback, plus **conflict analysis with fix
  hints** (unresolvable bundles, missing `dsh.bundle`, broken patch files,
  duplicate entry ids, unmatched patch rows, self-referencing deps, leftover
  install-recovery transactions…).
- **Preflight** — boot-free `dsh --profile <p> --dump-config` + local compose
  validation.
- No online marketplace component.

## Quick start

1. Double-click `启动 Kidai Plugin Remote.cmd` — opens the manager in an
   app-mode browser window at `http://127.0.0.1:4877` (close the console to
   stop the manager; DSH is unaffected).
2. Or build the single-file exe once: `powershell -File scripts/build-exe.ps1`
   (uses the in-box .NET Framework csc.exe, zero downloads) → run
   `build\Kidai Plugin Remote.exe` (self-extracts to
   `%LOCALAPPDATA%\KidaiPluginRemote\app`).
3. Or run the source directly: `node server.js`
   (`KPR_PORT`, `KPR_NO_OPEN=1`, `KPR_DATA`, `KPR_NODE` env overrides).

Read-only self-check (never launches DSH, never writes config):

```
node scripts/self-check.mjs
```

## How it works

- **Read** — `$DSH_HOME` (`DSH_HOME` or `~/.dsh`) → profiles → two-anchor
  bundle resolution (DSH install first, then profile) → patch layers applied
  in boot order with the include plugin's exact patch algorithm (`!!js`
  expressions are parsed, never evaluated). The result matches what DSH
  actually boots.
- **Write** — toggles only touch the home-level `cordis.patch.yml` (same as the
  market); isolation additionally writes the desktop's
  `plugin-management/state.json` and restores both on exit.
- **Launch** — spawns `DSH Desktop.exe` (auto-discovered, or `DSH_DESKTOP_DIR`);
  success = the desktop's own health-commit; failure evidence from exit code,
  `%APPDATA%\DSH Desktop\logs`, `crash-evidence`, `profile-selection`, and
  `plugin-install-recovery`.
- **CLI checks** — `dsh --dump-config` needs Node ≥ 22; when the system node
  is older the manager reuses the desktop's own runtime via
  `ELECTRON_RUN_AS_NODE=1` (zero downloads), otherwise the button reports
  "unavailable" while local composition still works.

## Layout

```
kidai-plugin-remote/
├── server.js                # HTTP + API on 127.0.0.1:4877
├── lib/                     # dsh-env, patches, profile, inventory, conflicts, launcher
├── public/                  # single-page UI (no build step)
├── vendor/yaml/             # vendored yaml 2.9.0 (offline)
├── scripts/                 # self-check.mjs, build-exe.ps1, minimize-console.ps1
├── 启动 Kidai Plugin Remote.cmd
└── build/                   # packaged exe output
```

## License

MIT
