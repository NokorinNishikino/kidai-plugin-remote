#!/usr/bin/env node
/**
 * Kidai Plugin Remote — test-import-zip.mjs
 *
 * External-recovery end-to-end: KSG exports a full backup zip for a THROWAWAY
 * profile, the profile is then corrupted (config + package + settings), and
 * KPR's importZipAndRestore reads the zip and restores everything. The real
 * desktop profile is untouched; all test artifacts are removed afterwards.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeEnvironment } from "../lib/dsh-env.js";
import { composeProfileRows } from "../lib/profile.js";
import { importZipAndRestore } from "../lib/snapshots.js";
import { createSnapshot, exportSnapshotZip, resolveDshHome, resolveActiveProfile } from "../../kidai-snapshot-guard/lib/backup.js";

const PROFILE = "kpr-import-test";
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
const profileDir = join(HOME, "profiles", PROFILE);
const pkgDir = join(profileDir, "node_modules", "dsh-fake-pkg");
const write = (p, text) => writeFileSync(p, text, "utf8");
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

console.log("== external recovery: KSG zip -> KPR importZipAndRestore ==");

// --- setup: a profile with one third-party package + a settings.yaml ---
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });
// Back up the REAL home patch so the disable-suspected test never pollutes it.
const homePatchPath = join(HOME, "cordis.patch.yml");
const homePatchBackup = existsSync(homePatchPath) ? readFileSync(homePatchPath, "utf8") : null;
write(join(profileDir, "package.json"), JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg" }, dsh: { profile: { bundles: [] } } }, null, 2));
write(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-fake-pkg", version: "1.0.0", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2));
write(join(pkgDir, "index.js"), "export default {}\n");
write(join(pkgDir, "cordis.patch.yml"), "- insert:\n    - id: fake-pkg\n      name: 'dsh-fake-pkg'\n");
write(join(HOME, "settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: test\n");

// --- 1) KSG export zip (full) ---
const exp = exportSnapshotZip({ home: HOME, profileName: PROFILE, trigger: "manual", note: "external-recovery-test" });
ok(exp.ok && existsSync(exp.path), `KSG export zip ok: ${exp.path}`);
const zipBuffer = readFileSync(exp.path);

// --- 2) corrupt everything (the "DSH cannot boot" state) ---
write(join(profileDir, "package.json"), JSON.stringify({ name: "broken", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "totally-broken-pkg"] } } }, null, 2));
rmSync(pkgDir, { recursive: true, force: true });
write(join(HOME, "settings.yaml"), "broken: true\n");
ok(!existsSync(pkgDir), "state corrupted (package dir gone, manifest broken)");

// --- 3) KPR external restore from the zip ---
const env = probeEnvironment();
const composed = composeProfileRows(env, PROFILE, {});
const result = await importZipAndRestore(env, PROFILE, composed, zipBuffer);
if (!result.ok) console.log("  failure detail:", result.message);
ok(result.ok === true, `importZipAndRestore ok (${result.restored} restored / ${result.failed} failed)`);

const manifestAfter = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
ok(manifestAfter.dependencies?.["dsh-fake-pkg"] !== undefined, "profile manifest restored (dependency back)");
ok(JSON.stringify(manifestAfter.dsh?.profile?.bundles) === "[]", "bundles restored");
ok(existsSync(join(pkgDir, "package.json")), "package dir restored from zip");
ok(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version === "1.0.0", "package version restored (1.0.0)");
ok(readFileSync(join(HOME, "settings.yaml"), "utf8").includes("welcomeNoticeVersion"), "settings.yaml restored");

// --- 4) suspected-plugin diagnosis: a package installed AFTER the snapshot ---
// (simulate "crash caused by a newly installed plugin": it is on disk but not
// in the backup) → the next restore must flag it as the likely culprit.
mkdirSync(join(profileDir, "node_modules", "dsh-suspect-pkg"), { recursive: true });
write(join(profileDir, "node_modules", "dsh-suspect-pkg", "package.json"), JSON.stringify({ name: "dsh-suspect-pkg", version: "9.9.9", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2));
write(join(profileDir, "node_modules", "dsh-suspect-pkg", "index.js"), "export default {}\n");
write(join(profileDir, "node_modules", "dsh-suspect-pkg", "cordis.patch.yml"), "- insert:\n    - id: suspect\n      name: 'dsh-suspect-pkg'\n");
write(join(profileDir, "package.json"), JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg", "dsh-suspect-pkg": "file:./node_modules/dsh-suspect-pkg" }, dsh: { profile: { bundles: [] } } }, null, 2));
const composed2 = composeProfileRows(env, PROFILE, {});
const result2 = await importZipAndRestore(env, PROFILE, composed2, zipBuffer);
ok(Array.isArray(result2.suspected) && result2.suspected.some((s) => s.name === "dsh-suspect-pkg"), "suspected plugin detected (added after snapshot)");
ok(result2.suspected.some((s) => s.name === "dsh-suspect-pkg" && s.version === "9.9.9"), "suspected entry carries the on-disk version");

// --- 5) disable-suspected option: restore + auto-disable the culprit ---
// (re-add the suspect to the manifest so the pre-restore diff sees it again)
write(join(profileDir, "package.json"), JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg", "dsh-suspect-pkg": "file:./node_modules/dsh-suspect-pkg" }, dsh: { profile: { bundles: [] } } }, null, 2));
const composed3 = composeProfileRows(env, PROFILE, {});
const result3 = await importZipAndRestore(env, PROFILE, composed3, zipBuffer, { disableSuspected: true });
ok(result3.ok === true, "restore with disableSuspected ok");
ok(Array.isArray(result3.disabled) && result3.disabled.length >= 1, `suspected plugins auto-disabled (${(result3.disabled ?? []).join(", ")})`);
const homePatchText = readFileSync(homePatchPath, "utf8");
ok(/disabled:\s*true/.test(homePatchText) && /suspect/.test(homePatchText), "disabled row targets the suspect plugin");

// --- cleanup ---
rmSync(profileDir, { recursive: true, force: true });
rmSync(join(HOME, ".kidai-snapshots", exp.id), { recursive: true, force: true });
rmSync(join(HOME, ".kidai-snapshots", "exports"), { recursive: true, force: true });
if (homePatchBackup !== null) write(homePatchPath, homePatchBackup);
else rmSync(homePatchPath, { recursive: true, force: true });
write(join(HOME, "settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: test\n");
ok(!existsSync(profileDir), "throwaway profile removed");
console.log(process.exitCode === 1 ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
