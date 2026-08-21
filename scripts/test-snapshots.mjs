#!/usr/bin/env node
/**
 * Kidai Plugin Remote — test-snapshots.mjs
 *
 * End-to-end check of the snapshot/rollback contract on a THROWAWAY profile
 * (`kpr-snapshot-test`): create → mutate → rollback → verify restore, plus
 * the guard's pending→verified promotion. The throwaway profile is removed
 * afterwards; the real desktop profile is never touched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeEnvironment } from "../lib/dsh-env.js";
import { composeProfileRows } from "../lib/profile.js";
import { createSnapshot, rollbackSnapshot, readSnapshotMeta, listSnapshots, setSnapshotStatus } from "../lib/snapshots.js";
import { verifyPendingSnapshots, resolveDshHome } from "../../kidai-snapshot-guard/lib/index.js";

const PROFILE = "kpr-snapshot-test";
const env = probeEnvironment();
const profileDir = join(env.dshHome, "profiles", PROFILE);
const pkgDir = join(profileDir, "node_modules", "dsh-fake-pkg");
const manifestPath = join(profileDir, "package.json");
const pkgManifestPath = join(pkgDir, "package.json");
const enc = new TextEncoder();
const write = (path, text) => writeFileSync(path, text, "utf8");

const ok = (condition, label) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) process.exitCode = 1;
};

console.log("== snapshot/rollback lifecycle (throwaway profile) ==");

// --- setup ---
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });
write(manifestPath, JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg" }, dsh: { profile: { bundles: [] } } }, null, 2));
write(pkgManifestPath, JSON.stringify({ name: "dsh-fake-pkg", version: "1.0.0", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2));
write(join(pkgDir, "index.js"), "export default {}\n");
write(join(pkgDir, "cordis.patch.yml"), "- insert:\n    - id: fake-pkg\n      name: 'dsh-fake-pkg'\n");

// --- 1) snapshot the pre-change state ---
let composed = composeProfileRows(env, PROFILE, {});
const snap = createSnapshot(env, PROFILE, composed, { trigger: "mutate", note: "test: before change" });
ok(snap.status === "pending", `snapshot created pending (${snap.id})`);
ok(Object.keys(snap.packages).includes("dsh-fake-pkg"), "third-party package copied into snapshot");
ok(existsSync(join(env.dshHome, ".kidai-snapshots", snap.id, "profile.package.json")), "profile manifest copied");

// --- 2) simulate a bad update: bump version + add bundle ---
write(manifestPath, JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { "dsh-fake-pkg": "file:./node_modules/dsh-fake-pkg" }, dsh: { profile: { bundles: ["dsh-fake-pkg"] } } }, null, 2));
write(pkgManifestPath, JSON.stringify({ name: "dsh-fake-pkg", version: "2.0.0", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2));
ok(JSON.parse(readFileSync(pkgManifestPath, "utf8")).version === "2.0.0", "bad update applied (pkg 2.0.0, bundle added)");

// --- 3) rollback ---
composed = composeProfileRows(env, PROFILE, {});
const rb = await rollbackSnapshot(env, PROFILE, composed, snap.id);
ok(rb.ok === true, `rollback ok: ${rb.message.split("\n")[0]}`);
const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkgAfter = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
ok(JSON.stringify(manifestAfter.dsh.profile.bundles) === "[]", "bundles restored to pre-change ([])");
ok(pkgAfter.version === "1.0.0", "package version restored to 1.0.0");
ok(readSnapshotMeta(env.dshHome, snap.id).status === "rolled-back", "snapshot marked rolled-back");

// --- 4) guard: pending → verified on a successful boot ---
const snap2 = createSnapshot(env, PROFILE, composeProfileRows(env, PROFILE, {}), { trigger: "launch", note: "test: before launch" });
ok(snap2.status === "pending", "launch snapshot created pending");
const verified = verifyPendingSnapshots(env.dshHome);
ok(verified >= 1, `guard verified ${verified} pending snapshot(s)`);
ok(readSnapshotMeta(env.dshHome, snap2.id).status === "verified", "guard promoted pending -> verified");
ok(readSnapshotMeta(env.dshHome, snap2.id).verifiedBy === "kidai-snapshot-guard", "verifiedBy recorded");

// --- cleanup throwaway snapshots + profile ---
for (const snap of listSnapshots(env, PROFILE)) {
  try { rmSync(join(env.dshHome, ".kidai-snapshots", snap.id), { recursive: true, force: true }); } catch {}
}
rmSync(profileDir, { recursive: true, force: true });
ok(!existsSync(profileDir), "throwaway profile removed");
console.log(process.exitCode === 1 ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
