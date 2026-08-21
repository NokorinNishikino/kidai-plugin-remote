#!/usr/bin/env node
/**
 * Kidai Plugin Remote — test-isolation.mjs
 *
 * One-shot isolation regression on a THROWAWAY environment:
 *   - applyIsolation exempts the snapshot guard (bundle + entry) so the
 *     in-DSH guard can auto-restore on the next launch, and writes a
 *     self-contained isolation marker (original home patch + plugin-management
 *     state + spawned PID);
 *   - restoreIsolationMarker / abortIsolation / checkIsolationStale recover
 *     the previous config when the recorded DSH is gone (direct shortcut
 *     launch, manager killed mid-isolation);
 *   - KSG's maybeRestoreIsolation restores on a PID-mismatched launch and
 *     skips on the same-PID (still-watched) launch.
 *
 * Everything runs against a temp HOME + temp APPDATA (isolated via env
 * overrides) — the real desktop profile, plugin-management state and guard
 * settings are never touched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyIsolation,
  restoreIsolationMarker,
  abortIsolation,
  checkIsolationStale,
  clearStaleIsolationBeforeLaunch,
  isolationMarkerPath,
} from "../lib/launcher.js";
import { maybeRestoreIsolation } from "../../kidai-snapshot-guard/lib/backup.js";

const PROFILE = "kpr-iso-test";
const ROOT = join(tmpdir(), `kpr-iso-${Date.now()}`);
const HOME = join(ROOT, "home");
const APPDATA = join(ROOT, "appdata");
const profileDir = join(HOME, "profiles", PROFILE);
const homePatch = join(HOME, "cordis.patch.yml");
const pmStatePath = join(APPDATA, "DSH Desktop", "plugin-management", "state.json");

const write = (p, text) => writeFileSync(p, text, "utf8");
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const ORIGINAL_PATCH = "- insert:\n    - id: my-panel\n      name: 'dsh-my-panel'\n";
const ORIGINAL_PM = JSON.stringify({ version: 1, profiles: [{ profileName: PROFILE, disabledBundles: ["dsh-legacy"] }] }, null, 2) + "\n";

const fakeEnv = {
  dshHome: HOME,
  pluginManagementPath: pmStatePath,
  desktopPids: [],
};

console.log("== one-shot isolation (throwaway HOME/APPDATA) ==");

// --- setup ---
const oldAppData = process.env.APPDATA;
const oldKprData = process.env.KPR_DATA;
process.env.APPDATA = APPDATA;
process.env.KPR_DATA = join(ROOT, "kpr-data");
mkdirSync(join(profileDir, "node_modules", "dsh-fake-pkg"), { recursive: true });
mkdirSync(join(profileDir, "node_modules", "kidai-snapshot-guard"), { recursive: true });
write(join(profileDir, "package.json"), JSON.stringify({
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dependencies: {
    "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg",
    "kidai-snapshot-guard": "file:./node_modules/kidai-snapshot-guard",
  },
  dsh: { profile: { bundles: ["dsh-fake-pkg", "kidai-snapshot-guard"] } },
}, null, 2));
write(homePatch, ORIGINAL_PATCH);
mkdirSync(join(pmStatePath, ".."), { recursive: true });
write(pmStatePath, ORIGINAL_PM);

const composed = {
  rows: [
    { id: "fake-pkg", name: "dsh-fake-pkg" },
    { id: "snapshot-guard", name: "kidai-snapshot-guard" },
    { id: "native-core", name: "@deepseek-ai/dsh-base" },
  ],
};

// --- 1) applyIsolation: guard exempted, marker written ---
const applied = applyIsolation(fakeEnv, PROFILE, composed, { pid: 12345 });
ok(applied.ok === true, "applyIsolation ok");
ok(
  JSON.stringify(applied.disabledBundles) === JSON.stringify(["dsh-fake-pkg"]),
  `guard bundle exempted (disabled=${JSON.stringify(applied.disabledBundles)})`,
);
const pmAfter = JSON.parse(read(pmStatePath));
const myProfile = pmAfter.profiles.find((p) => p.profileName === PROFILE);
ok(
  JSON.stringify(myProfile?.disabledBundles) === JSON.stringify(["dsh-fake-pkg"]),
  `plugin-management disables only third-party bundles (${JSON.stringify(myProfile?.disabledBundles)})`,
);
ok(!read(homePatch).includes("snapshot-guard"), "home patch does not disable the guard entry");
ok(read(homePatch).includes("fake-pkg") && read(homePatch).includes("disabled: true"), "home patch disables fake-pkg");
ok(!read(homePatch).includes("native-core"), "native rows untouched");
const marker = JSON.parse(read(isolationMarkerPath(HOME)));
ok(marker.active === true && marker.pid === 12345 && marker.profile === PROFILE, "marker written with pid/profile");
ok(marker.homePatch === ORIGINAL_PATCH, "marker embeds original home patch");
ok(marker.pmState === ORIGINAL_PM, "marker embeds original plugin-management state");

// --- 2) restoreIsolationMarker ---
const restored = restoreIsolationMarker(fakeEnv, PROFILE);
ok(restored.hadMarker === true, "marker consumed");
ok(restored.restored.length >= 2, `restored ${restored.restored.length} file(s)`);
ok(read(homePatch) === ORIGINAL_PATCH, "home patch restored to original");
ok(read(pmStatePath) === ORIGINAL_PM, "plugin-management restored to original");
ok(!existsSync(isolationMarkerPath(HOME)), "marker file removed");
ok(restoreIsolationMarker(fakeEnv, PROFILE).hadMarker === false, "second restore is a no-op");

// --- 3) KSG maybeRestoreIsolation: PID mismatch restores, same PID skips ---
applyIsolation(fakeEnv, PROFILE, composed, { pid: 999999 });
ok(existsSync(isolationMarkerPath(HOME)), "marker re-applied (foreign pid)");
const rec = maybeRestoreIsolation(HOME);
ok(rec.hadMarker === true && rec.skipped === false, "KSG recovered the foreign-PID marker");
ok(rec.restored.includes("cordis.patch.yml"), "KSG restored home patch");
ok(rec.restored.includes("plugin-management/state.json"), "KSG restored plugin-management state");
ok(read(homePatch) === ORIGINAL_PATCH, "home patch back after KSG recovery");
ok(read(pmStatePath) === ORIGINAL_PM, "pm state back after KSG recovery");
ok(!existsSync(isolationMarkerPath(HOME)), "marker cleared by KSG");

applyIsolation(fakeEnv, PROFILE, composed, { pid: process.pid });
const same = maybeRestoreIsolation(HOME);
ok(same.hadMarker === true && same.skipped === true, "same-PID launch keeps isolation (skipped)");
ok(existsSync(isolationMarkerPath(HOME)), "marker kept for the watched launch");
restoreIsolationMarker(fakeEnv, PROFILE);

// --- 4) checkIsolationStale (KPR side): pid alive / external / exited ---
const kprData = join(ROOT, "kpr-data");
const runStatePath = join(kprData, "run-state.json");
applyIsolation(fakeEnv, PROFILE, composed, { pid: 777 });
mkdirSync(kprData, { recursive: true });
write(runStatePath, JSON.stringify({ pid: 777, mode: "isolated", profileName: PROFILE, isolating: true, startedAt: new Date().toISOString() }, null, 2));
fakeEnv.desktopPids = [777];
const alive = checkIsolationStale(fakeEnv);
ok(alive.action === "none", "recorded pid alive → keep watching");
ok(existsSync(isolationMarkerPath(HOME)), "marker still present while watched");

fakeEnv.desktopPids = [888];
const external = checkIsolationStale(fakeEnv);
ok(external.action === "external-launch", `external launch detected (${external.action})`);
ok(external.restored.length >= 1, "external launch recovered files");
ok(read(homePatch) === ORIGINAL_PATCH, "external launch restored home patch");
ok(!existsSync(isolationMarkerPath(HOME)), "external launch cleared the marker");
ok(!existsSync(runStatePath), "external launch cleared run state");

applyIsolation(fakeEnv, PROFILE, composed, { pid: 555 });
write(runStatePath, JSON.stringify({ pid: 555, mode: "isolated", profileName: PROFILE, isolating: true, startedAt: new Date().toISOString() }, null, 2));
fakeEnv.desktopPids = [];
const exited = checkIsolationStale(fakeEnv);
ok(exited.action === "exited", `DSH exited detected (${exited.action})`);
ok(!existsSync(isolationMarkerPath(HOME)), "exited run cleared the marker");

// --- 5) abortIsolation works without any run record (marker only) ---
applyIsolation(fakeEnv, PROFILE, composed, { pid: 444 });
rmSync(runStatePath, { force: true });
const aborted = abortIsolation(fakeEnv, PROFILE);
ok(aborted.ok === true, "abort ok without run record");
ok(aborted.restored.length >= 1, `abort restored ${aborted.restored.length} file(s)`);
ok(read(homePatch) === ORIGINAL_PATCH, "abort restored home patch");
ok(!existsSync(isolationMarkerPath(HOME)), "abort cleared marker");
const noop = abortIsolation(fakeEnv, PROFILE);
ok(noop.ok === false, "abort with nothing to restore reports failure");

// --- 6) clearStaleIsolationBeforeLaunch: normal launch must not inherit a
//     leftover isolation that the in-DSH guard would later restore over. ---
// 6a) stale marker + stale run record (no live pid) → dropped, config kept.
applyIsolation(fakeEnv, PROFILE, composed, { pid: 333 });
write(runStatePath, JSON.stringify({ pid: 333, mode: "isolated", profileName: PROFILE, isolating: true, startedAt: new Date().toISOString() }, null, 2));
fakeEnv.desktopPids = [];
const cleared = clearStaleIsolationBeforeLaunch(fakeEnv);
ok(cleared.cleared === true, "stale isolation cleared before normal launch");
ok(!existsSync(isolationMarkerPath(HOME)), "marker dropped");
ok(!existsSync(runStatePath), "run record dropped");
ok(read(homePatch) !== ORIGINAL_PATCH, "on-disk config (isolation state) kept — not restored");
// 6b) watched isolation (recorded pid alive) → untouched.
applyIsolation(fakeEnv, PROFILE, composed, { pid: 222 });
write(runStatePath, JSON.stringify({ pid: 222, mode: "isolated", profileName: PROFILE, isolating: true, startedAt: new Date().toISOString() }, null, 2));
fakeEnv.desktopPids = [222];
const watched = clearStaleIsolationBeforeLaunch(fakeEnv);
ok(watched.cleared === false, "watched isolation left untouched");
ok(existsSync(isolationMarkerPath(HOME)), "watched marker kept");
restoreIsolationMarker(fakeEnv, PROFILE);

// --- cleanup ---
process.env.APPDATA = oldAppData;
if (oldKprData !== undefined) process.env.KPR_DATA = oldKprData;
else delete process.env.KPR_DATA;
rmSync(ROOT, { recursive: true, force: true });
ok(!existsSync(ROOT), "throwaway environment removed");
console.log(process.exitCode === 1 ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
