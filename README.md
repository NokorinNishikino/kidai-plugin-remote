# Kidai Plugin Remote · Rescue & Daily Manager for DeepSeek Harness

> **The plugin manager that keeps working even when DSH is broken.**

List, toggle, launch, isolate, snapshot and roll back DeepSeek Harness (DSH)
plugins — **completely outside DSH**. When DSH refuses to boot, this is the
tool that gets you back in: disable the suspect plugin, roll back to a known
good snapshot, or boot a native-only baseline for diagnosis.

**中文说明：[README.zh.md](README.zh.md)**

[![standalone](https://img.shields.io/badge/standalone-outside%20DSH-4d8dff)](https://github.com/) · [![no-network-market](https://img.shields.io/badge/no-network-market-7c6fe0)]() · [![MIT](https://img.shields.io/badge/license-MIT-green)]()

---

## ✨ Highlights

| | |
|---|---|
| **🛟 Rescue first** | Designed for the moment DSH won't open: isolated native-only run, one-click rollback, failure diagnosis with fix hints |
| **📋 Same engine as the Kidai Market** | Plugin list composed exactly like the market reads it — bundle layers → profile patch → home patch → desktop overlay |
| **🧊 One-shot isolation** | This run disables all third-party plugins; the previous config **auto-restores** on exit — even if the manager is killed, the in-DSH guard restores it on next launch |
| **💾 Snapshot & rollback** | Every launch / config change keeps a pending snapshot; verified on the next successful run. Offline rollback of config + third-party package dirs |
| **🩺 Startup failure reports** | Exit code, logs, crash dumps + conflict analysis and concrete fix hints |
| **🧩 Plugin management** | Orphan scan / mount / file cleanup / uninstall with entry validation (Kidai Market Hub 1.3.4 parity) |
| **🎨 Themed UI** | 8 color themes (dark / light / DS blue / sage / violet / teal / coral / rose), saved server-side |
| **🧲 Full control** | 4 start modes (normal / isolated / preflight / report), auto-minimize on success |

## 🚀 Quick start

**Option A — zero-dependency desktop app (recommended for distribution)**

Grab `Kidai Plugin Remote Client` from the companion repo
[**kidai-plugin-remote-client**](https://github.com/) — download, unzip,
double-click. No Node, no browser.

**Option B — classic launcher**

```
install.cmd          # one-click: checks Node, installs the in-DSH guard, desktop shortcut
启动 Kidai Plugin Remote.cmd   # run directly
```

or from source:

```bash
node server.js       # opens the manager at http://127.0.0.1:4877
node scripts/self-check.mjs   # read-only self check
```

Requirements: **Node.js ≥ 20** on the machine (DSH itself is not needed).

## 🔗 Ecosystem

```
kidai-plugin-remote         ← you are here: external manager (browser UI)
kidai-plugin-remote-client  ← zero-dependency Electron desktop client
kidai-snapshot-guard        ← in-DSH guard: snapshots, isolation recovery, notices
```

| Repo | Role | Runs where |
|---|---|---|
| **kidai-plugin-remote** | list/toggle/launch/isolate/rollback | outside DSH (standalone) |
| **kidai-plugin-remote-client** | same manager, native window, no deps | outside DSH (standalone) |
| **kidai-snapshot-guard** | snapshots, pending→verified, auto-recovery | inside DSH (plugin) |

All three share one snapshot store (`$DSH_HOME/.kidai-snapshots`) and one
guard directory (`$DSH_HOME/guard/`) — edit a snapshot note in any of them and
the others see it.

## 📸 How it works (technical)

- **Read** — `$DSH_HOME` → profile manifest `dsh.profile.bundles` → two-anchor
  bundle resolution (DSH install first, then profile) → patch layers applied
  in boot order with the include plugin's exact patch algorithm (`!!js` parsed,
  never evaluated) → the real loader entry tree.
- **Write** — toggles only touch the home-level `cordis.patch.yml` (identical
  to the market); isolation additionally writes the desktop-private
  `plugin-management/state.json` and restores both on exit or on the next
  launch (one-shot guarantee, enforced by the in-DSH guard).
- **Launch** — spawns `DSH Desktop.exe` (auto-discovered or `DSH_DESKTOP_DIR`);
  success = the desktop's own health-commit; failure evidence from exit code,
  `%APPDATA%\DSH Desktop\logs`, `crash-evidence`, `profile-selection`,
  `plugin-install-recovery`.
- **CLI checks** — `dsh --dump-config` needs Node ≥ 22; with an older system
  node the manager reuses the desktop's own runtime via
  `ELECTRON_RUN_AS_NODE=1` (zero downloads).
- **Resilience** — any single broken bundle (corrupt manifest, missing
  directory, bad patch) is skipped and reported, never fatal: the manager,
  its client and its UI keep working so you can fix the culprit.

## 🗂 Layout

```
kidai-plugin-remote/
├── server.js                # HTTP + API on 127.0.0.1:4877
├── lib/                     # dsh-env · patches · profile · inventory · conflicts · plugin-mgmt · snapshots · launcher
├── public/                  # single-page UI (no build step) + 8 themes
├── vendor/yaml/             # vendored yaml 2.9.0 (fully offline)
├── scripts/                 # self-check · test-* · install-guard · install-shortcut · build-exe
├── install.cmd              # one-click install
├── 启动 Kidai Plugin Remote.cmd
└── build/                   # packaged exe output
```

## 📄 License

MIT
