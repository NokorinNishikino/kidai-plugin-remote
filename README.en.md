<div align="center">

# 🛟 Kidai Plugin Remote

**The plugin manager that keeps working even when DSH is broken** — list · toggle · launch · isolate · snapshot · rollback

[**简体中文**](README.md) · **English**

</div>

---

## ✨ Why?

DeepSeek Harness (DSH) plugin failures usually come from the plugins
themselves: broken bundle lists, missing dependencies, self-referencing
`file:./node_modules/...` deps... once DSH refuses to boot, DSH cannot save
itself. **Kidai Plugin Remote** is the external rescue & daily manager built
for exactly that moment — it runs outside DSH, so it works even when DSH is
broken.

- 🛟 **Rescue first** — failure reports include exit code, logs, crash dumps,
  conflict analysis and concrete fix hints; one-click rollback to a known-good
  snapshot, or an **isolated native-only run** for diagnosis
- 📋 **Same engine as the Kidai Market** — the plugin list is composed exactly
  like the market reads it (bundle layers → profile patch → home patch →
  desktop overlay)
- 🧊 **One-shot isolation** — disables all third-party plugins for this run;
  the previous config auto-restores on exit — even if the manager is killed,
  the in-DSH guard restores it on next launch
- 💾 **Snapshot & rollback** — every launch / config change keeps a pending
  snapshot, verified on the next successful run; offline rollback of config +
  third-party package dirs
- 🧩 **Plugin management** — orphan scan / mount / cleanup / uninstall with
  entry validation (Kidai Market Hub 1.3.4 parity)
- 🎨 **8 color themes** — dark / light / DS blue / sage / violet / teal / coral /
  rose, remembered server-side
- 🧲 **4 start modes** — normal / isolated / preflight / failure report;
  auto-minimize on success

> **No technical knowledge required** — open and use; developers get the full
> composition diagnostics.

---

## 🚀 Quick start

**Option A — zero-dependency desktop app (recommended for distribution)**

Grab `Kidai Plugin Remote Client.exe` from the companion repo
[**kidai-plugin-remote-client**](https://github.com/NokorinNishikino/kidai-plugin-remote-client)
— download, unzip, double-click. No Node, no browser.

**Option B — classic launcher**

```
install.cmd                       # one-click: checks Node, installs the in-DSH guard, desktop shortcut
启动 Kidai Plugin Remote.cmd      # run directly (browser app window)
```

or from source:

```bash
node server.js                    # opens the manager at http://127.0.0.1:4877
node scripts/self-check.mjs       # read-only self check
```

Requirements: **Node.js ≥ 20** on the machine (DSH itself is not needed).

---

## 🔗 Ecosystem

| Repo | Role | Runs where |
|---|---|---|
| **kidai-plugin-remote** (you are here) | list / toggle / launch / isolate / rollback | outside DSH |
| [**kidai-plugin-remote-client**](https://github.com/NokorinNishikino/kidai-plugin-remote-client) | same manager, native window, zero deps | outside DSH |
| [**kidai-snapshot-guard**](https://github.com/NokorinNishikino/kidai-snapshot-guard) | snapshots, pending→verified, isolation recovery | inside DSH |

All three share one snapshot store (`$DSH_HOME/.kidai-snapshots`) and one
guard directory (`$DSH_HOME/guard/`) — annotate a snapshot in any of them and
the others see it.

---

## 📸 How it works (technical)

- **Read** — `$DSH_HOME` → profile manifest `dsh.profile.bundles` → two-anchor
  bundle resolution (DSH install first, then profile) → patch layers applied
  in boot order with the include plugin's exact patch algorithm (`!!js` parsed,
  never evaluated) → the real loader entry tree.
- **Write** — toggles only touch the home-level `cordis.patch.yml` (identical
  to the market); isolation additionally writes the desktop-private
  `plugin-management/state.json` and restores both on exit or next launch.
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
