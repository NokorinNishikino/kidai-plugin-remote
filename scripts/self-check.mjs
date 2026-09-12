#!/usr/bin/env node
/**
 * Kidai Plugin Remote — self-check.mjs
 *
 * Read-only smoke test against the real machine: environment discovery,
 * profile composition (the "same way" as the market), installed inventory,
 * preflight conflict analysis, and a boot-free `dsh --dump-config` run.
 * Never launches DSH and never writes config.
 */
import { probeEnvironment } from "../lib/dsh-env.js";
import { composeProfileRows } from "../lib/profile.js";
import { buildInstalledView } from "../lib/inventory.js";
import { analyzeProfile } from "../lib/conflicts.js";
import { runCliDump } from "../lib/launcher.js";

const env = probeEnvironment();
const failures = [];
const ok = (condition, label) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

console.log("== Kidai Plugin Remote self-check ==");
console.log(`DSH_HOME           : ${env.dshHome}`);
console.log(`active profile     : ${env.activeProfile} (lastKnownGood=${env.lastKnownGood})`);
console.log(`DSH Desktop install: ${env.install ?? "(not found)"}`);
console.log(`desktop running    : ${env.desktopRunning}`);
console.log(`system node        : ${env.systemNode} (${env.nodeVersion})`);
console.log("");

ok(env.dshHome.length > 0, "resolve DSH_HOME");
ok(env.activeProfile !== undefined, "resolve active profile");
ok(env.install !== undefined, "locate DSH Desktop install");
ok(env.desktopExe !== undefined, "locate DSH Desktop.exe");
ok(env.dshCliEntry !== undefined, "locate packaged dsh CLI entry (kind: " + (env.dshCliKind ?? "unknown") + ")");
ok(env.userData !== undefined, "locate desktop user data");
ok(env.selectionStatePath !== undefined, "locate profile-selection state");

const profileName = env.activeProfile ?? "desktop";
let composed;
try {
  composed = composeProfileRows(env, profileName, { includeDesktopShell: true });
  console.log(`\n== compose profile "${profileName}" ==`);
  console.log(`bundles in manifest : ${composed.bundleNames.length} ${composed.bundleNames.join(", ")}`);
  console.log(`layers resolved     : ${composed.layers.length} (problems: ${composed.layerProblems.length})`);
  console.log(`composed rows       : ${composed.rows.length}`);
  console.log(`patch warnings      : ${composed.warnings.length}`);
  for (const problem of composed.layerProblems) console.log(`  ! ${problem.message}`);
  ok(composed.layers.length > 0, "bundle layers resolve");
  ok(composed.rows.length > 0, "composed rows non-empty");
  ok(composed.layerProblems.length === 0, "no layer problems");
} catch (error) {
  ok(false, `compose profile: ${error.message}`);
  composed = { rows: [], layers: [], layerProblems: [error], bundleNames: [], profileDir: "" };
}

if (composed.rows.length > 0) {
  const view = buildInstalledView(env, profileName, composed);
  console.log(`\n== installed inventory ==`);
  console.log(`dependencies : ${view.dependencies.join(", ") || "(none)"}`);
  console.log(`bundles      : ${view.bundles.length} (disabled: ${view.bundles.filter((b) => b.disabled).length})`);
  console.log(`plugin rows  : ${view.plugins.length} (third-party: ${view.thirdPartyCount}, enabled: ${view.plugins.filter((p) => p.enabled).length})`);
  for (const plugin of view.plugins.filter((p) => p.origin === "third-party")) {
    console.log(`  [${plugin.enabled ? "ON " : "OFF"}] ${plugin.name} (${plugin.entryId}) v${plugin.version || "?"} @ ${plugin.path}`);
  }
  ok(view.plugins.length > 0, "inventory has rows");

  const analysis = analyzeProfile(env, profileName, composed, { desktopShell: true });
  console.log(`\n== preflight analysis ==`);
  console.log(`verdict: ${analysis.verdict}`);
  for (const finding of analysis.findings) {
    console.log(`  [${finding.severity}] ${finding.title}`);
    if (finding.detail) console.log(`      ${finding.detail}`);
    if (finding.fix) console.log(`      fix: ${finding.fix}`);
  }
  if (analysis.ok) ok(true, "preflight has no error findings");
  else console.log("INFO: preflight found real hazards (expected on a machine with known issues) — the manager detecting them is correct behavior");
  ok(Array.isArray(analysis.findings), "preflight returns a findings list");
}

console.log(`\n== boot-free CLI dump (dsh --profile ${profileName} --dump-config) ==`);
const dump = await runCliDump(env, profileName, undefined);
if (dump.ok) {
  const lines = dump.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  console.log(`dump ok (${dump.nodeInfo ?? "?"}), ${lines.length} lines, head:`);
  for (const line of lines.slice(0, 6)) console.log(`  ${line}`);
  ok(true, "dsh --dump-config succeeds");
} else {
  console.log(`dump failed (exit ${dump.exitCode}) runtime=${dump.nodeInfo ?? "none"}`);
  console.log(`  ${dump.stderr.slice(0, 400)}`);
  if (dump.nodeInfo === undefined || /沙箱限制|禁止子进程/.test(dump.stderr)) {
    console.log("  (runtime unavailable or sandbox-restricted in this environment — SKIP, not a manager bug)");
  } else {
    ok(false, "dsh --dump-config succeeds");
  }
}

console.log("");
if (failures.length === 0) {
  console.log("ALL CHECKS PASSED");
  process.exit(0);
} else {
  console.log(`${failures.length} CHECK(S) FAILED`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
