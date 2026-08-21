/**
 * Kidai Plugin Remote — conflicts.js
 *
 * Startup preflight: analyze a profile's composed tree and the surrounding
 * environment for anything that would prevent DSH from booting, mirroring the
 * launcher's own failure modes (unresolvable bundles, missing `dsh.bundle`
 * declarations, broken patch files, duplicate entry ids, missing desktop
 * rows, the self-referencing `file:./node_modules/...` trap, last-known-good
 * rollback state, leftover install-recovery transactions), each with a fix
 * hint the user can act on.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyEntryPatches } from "./patches.js";
import { readPackageManifest } from "./profile.js";
import { resolvePackageDir } from "./inventory.js";
import { packageEntryExists } from "./plugin-mgmt.js";

/** Severity → label for the UI. */
export const SEVERITY_LABELS = { error: "高危", warn: "警告", info: "提示" };

/**
 * Attributed warnings: apply the flattened patch list on prefixes and diff the
 * warning tails — the same snapshot technique `renderConfigDump` uses.
 */
function layerWarnings(layers) {
  const result = [];
  let previous = [];
  let previousWarnings = [];
  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1];
    if (layer === undefined) continue;
    const flat = [];
    for (let index = 0; index < count; index += 1) flat.push(...(layers[index]?.patches ?? []));
    const { warnings } = applyEntryPatches([], flat);
    const added = warnings.slice(previousWarnings.length);
    result.push({ layer, warnings: added });
    previous = flat;
    previousWarnings = warnings;
  }
  return result;
}

/** Extract meaningful recent error lines from the newest desktop log file. */
export function recentDesktopLogErrors(logsDir, limit = 12) {
  try {
    if (!existsSync(logsDir)) return [];
    const files = readdirSync(logsDir)
      .filter((name) => /\.log$|^main\.|\.jsonl$/.test(name))
      .map((name) => ({ name, path: join(logsDir, name), mtime: statSync(join(logsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(0, 3)) {
      try {
        const text = readFileSync(file.path, "utf8");
        const lines = text.split(/\r?\n/).filter((line) => /error|fatal|failed|reject|cannot resolve|no dsh\.bundle/i.test(line));
        return lines.slice(-limit).map((line) => `[${file.name}] ${line.trim()}`);
      } catch {
        continue;
      }
    }
  } catch {
    /* no logs */
  }
  return [];
}

/** Leftover protected plugin-install recovery transactions. */
export function installRecoveryFindings(installRecoveryDir) {
  const findings = [];
  try {
    if (!existsSync(installRecoveryDir)) return findings;
    const entries = readdirSync(installRecoveryDir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(installRecoveryDir, entry.name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const phase = String(parsed?.phase ?? "");
        if (phase === "manual-recovery-required" || phase === "install-failed") {
          findings.push({
            severity: "warn",
            title: `存在未完成的受保护插件安装事务（${entry.name}）`,
            detail: `阶段：${phase}；插件：${String(parsed?.packageName ?? "未知")}@${String(parsed?.packageVersion ?? "")}。DSH Desktop 会在下次启动时要求你选择恢复方式。`,
            fix: "启动 DSH Desktop 并按提示选择恢复（回滚/重试），或删除该事务文件（先备份）。",
            source: path,
          });
        }
      } catch {
        /* not a recovery transaction */
      }
    }
  } catch {
    /* unreadable */
  }
  return findings;
}

/**
 * Full preflight for one profile.
 * @param desktopShell - whether the desktop launcher overlay was composed
 * (true for the active desktop profile), enabling the desktop-required-row
 * checks.
 * @returns `{ ok, findings, verdict }` — `ok` means no error-severity findings.
 */
export function analyzeProfile(env, profileName, composed, { desktopShell = false } = {}) {
  const findings = [];
  const push = (severity, title, detail, fix, source) =>
    findings.push({ severity, title, detail, fix, source });

  // -- environment --------------------------------------------------------
  if (env.install === undefined) {
    push(
      "error",
      "未找到 DSH Desktop 安装",
      "无法定位 DSH Desktop.exe 与 app.asar.unpacked 运行时。",
      "设置环境变量 DSH_DESKTOP_DIR 指向安装目录，或重新安装 DSH Desktop。",
    );
  }
  if (env.activeProfile !== undefined && env.lastKnownGood !== undefined && env.activeProfile !== env.lastKnownGood) {
    push(
      "warn",
      "上次启动失败，已回退到 last-known-good 配置",
      `profile-selection 状态：active=${env.activeProfile}，lastKnownGood=${env.lastKnownGood}。DSH Desktop 检测到上次启动未成功，会用最后可用配置重新打开。`,
      "先使用「隔离运行」验证原生 DSH 可启动，再逐个恢复插件。",
      env.selectionStatePath,
    );
  }
  if (env.desktopRunning) {
    push(
      "info",
      "DSH Desktop 正在运行",
      "启用/停用会通过 HMR 实时生效（下次重启也会保留）；启动按钮不可用，请先退出 DSH。",
      "先退出 DSH Desktop 再执行启动/隔离运行。",
    );
  }
  const pm = readPluginManagementStateSafe(env);
  if (pm !== undefined && pm.invalid) {
    push(
      "warn",
      "DSH Desktop 插件管理状态文件损坏",
      pm.error,
      "备份后修复 plugin-management/state.json，或删除它让桌面端重建。",
      env.pluginManagementPath,
    );
  }

  // -- layer problems -----------------------------------------------------
  for (const problem of composed.layerProblems ?? []) {
    const message = String(problem.message);
    if (/cannot resolve profile bundle/i.test(message)) {
      push(
        "error",
        `插件包无法解析：${problem.packageName}`,
        message,
        `安装该依赖：dsh plugin --profile ${profileName} add ${problem.packageName}（或先「隔离运行」再修复）。`,
        problem.source,
      );
    } else if (/declares no dsh\.bundle/i.test(message)) {
      push(
        "error",
        `插件包缺少 dsh.bundle 声明：${problem.packageName}`,
        message,
        "该包的 package.json 需声明 dsh.bundle.patch；修复或移除该 bundle。",
      );
    } else if (/failed to parse|must be a top-level|is empty/i.test(message)) {
      push("error", `插件包补丁文件损坏：${problem.packageName}`, message, "修复该包的 cordis.patch.yml 为顶层 YAML 数组。");
    } else {
      push("error", `插件包加载失败：${problem.packageName}`, message, "先「隔离运行」，再单独修复该插件。");
    }
  }
  if (composed.profilePatchProblem) {
    push(
      "error",
      "profile 级 cordis.patch.yml 无法解析",
      composed.profilePatchProblem,
      "修复为顶层 YAML 数组（可先用 `[]` 重置，管理器的备份可恢复）。",
      composed.profilePatch,
    );
  }
  if (composed.homePatchProblem) {
    push(
      "error",
      "home 级 cordis.patch.yml 无法解析",
      composed.homePatchProblem,
      "修复为顶层 YAML 数组（可先用 `[]` 重置，管理器的备份可恢复）。",
      composed.homePatch,
    );
  }
  if (composed.desktopOverlayProblem) {
    push(
      "error",
      "DSH Desktop 启动器 overlay 无法解析",
      composed.desktopOverlayProblem,
      "DSH Desktop 安装不完整或 desktop 自身 cordis.patch.yml 损坏。",
      env.desktopBundlePatchPath,
    );
  }

  // -- composed tree ------------------------------------------------------
  const seen = new Set();
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
    if (seen.has(row.id)) {
      push(
        "error",
        `组合树中存在重复的 loader 条目 id：「${row.id}」`,
        "DSH Desktop 启动时会因重复条目 id 直接失败（assertUniqueEntryIds）。",
        "检查各 bundle 的 cordis.patch.yml insert 与 patch 层，去掉重复 id。",
      );
    }
    seen.add(row.id);
  }

  // -- entry validation (hub 1.3.4 misakanet mode) ------------------------
  // A third-party mounted row whose package declares dsh.bundle but has no
  // loadable entry (main / exports["."] / index.js) fails the whole boot.
  const checkedEntries = new Set();
  for (const row of composed.rows ?? []) {
    if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
    if (row.name.startsWith("@deepseek-ai/")) continue;
    if (checkedEntries.has(row.name)) continue;
    checkedEntries.add(row.name);
    const path = resolvePackageDir(composed.profileDir, row.name);
    const pkg = readPackageManifest(path);
    if (pkg === null || pkg?.dsh?.bundle === undefined) continue;
    if (!packageEntryExists(path, pkg)) {
      push(
        "error",
        `插件声明 dsh.bundle 但没有可加载入口：${row.name}`,
        "该包声明了 dsh.bundle.patch 却没有 main/exports 入口文件，也没有 index.js。DSH 启动时加载器无法解析入口，会导致整个插件树启动失败（misakanet 故障模式）。",
        "该包很可能不是真正的 DSH 插件（如部署脚本仓库）。在管理器中用「删除文件」移除它，或改装已发布的 npm 插件。",
        path,
      );
    }
  }

  // per-layer patch warnings (patch targets absent from the tree), covering
  // every layer the boot applies: bundles, then the profile layer, then home.
  const allLayers = [
    ...(composed.layers ?? []),
    {
      packageName: "profile:cordis.patch.yml",
      patchPath: composed.profilePatch,
      patches: composed.profilePatches ?? [],
    },
    {
      packageName: "home:cordis.patch.yml",
      patchPath: composed.homePatch,
      patches: composed.homePatches ?? [],
    },
  ].filter((layer) => (layer.patches ?? []).length > 0);
  for (const { layer, warnings } of layerWarnings(allLayers)) {
    for (const warning of warnings) {
      push(
        "warn",
        `补丁未命中（${layer.packageName}）`,
        warning,
        "该 patch 行引用的条目 id 不在组合树中（跨 bundle 引用或 id 拼写错误）；如无必要可移除该行。",
        layer.patchPath,
      );
    }
  }

  // -- profile manifest hazards -------------------------------------------
  const dependencies = Object.entries(composed.manifest?.dependencies ?? {});
  for (const [name, spec] of dependencies) {
    if (typeof spec === "string" && spec.includes("file:./node_modules/")) {
      push(
        "error",
        `自引用依赖（file:./node_modules/...）：${name}`,
        `依赖声明为 file:./node_modules/${name}，指向 profile 自己的 node_modules——重装时该路径尚不存在，构成循环依赖，会导致 DSH 无法启动且无法用 dsh plugin 修复。`,
        "把该依赖改为正规版本号（如 ^0.1.0），或移除它；修复前可用「隔离运行」启动。",
        join(composed.profileDir, "package.json"),
      );
    }
  }

  // -- desktop-required rows ----------------------------------------------
  if (desktopShell) {
    const rowIds = new Set((composed.rows ?? []).map((row) => row?.id));
    for (const required of ["webserver", "desktop-shell", "settings"]) {      if (!rowIds.has(required)) {
        push(
          "error",
          `组合树缺少 DSH Desktop 必需条目：「${required}」`,
          "DSH Desktop 启动时会因缺少该条目直接失败（prepareDesktopProfile 断言）。",
          "检查 bundle 层与 patch 层是否覆盖了必需行；必要时先「隔离运行」验证原生基线。",
        );
      }
    }
  }

  // -- recovery leftovers --------------------------------------------------
  findings.push(...installRecoveryFindings(env.installRecoveryDir));

  // -- logs ----------------------------------------------------------------
  const logErrors = recentDesktopLogErrors(env.logsDir);
  if (logErrors.length > 0) {
    push(
      "info",
      "最近一次启动日志中的错误线索",
      logErrors.join("\n"),
      "结合上方高危项定位问题；日志目录：" + env.logsDir,
      env.logsDir,
    );
  }

  // -- !!js note -----------------------------------------------------------
  const jsExprUsed = JSON.stringify({ rows: composed.rows ?? [], patches: [composed.profilePatches, composed.homePatches] }).includes("__jsExpr");
  if (jsExprUsed) {
    push(
      "info",
      "配置层使用了 !!js 表达式",
      "管理器只解析展示、不评估 !!js 表达式；DSH 自身启动时会正常评估。",
      "无需处理。",
    );
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  return {
    ok: errors.length === 0,
    findings,
    verdict: errors.length > 0
      ? `${errors.length} 个高危问题会阻止启动`
      : findings.length > 0
        ? "可以启动，但有警告/提示"
        : "配置健康，可以启动",
  };
}

function readPluginManagementStateSafe(env) {
  const path = env.pluginManagementPath;
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
      return { invalid: true, error: "plugin-management/state.json 根结构无效" };
    }
    return { invalid: false };
  } catch (error) {
    return { invalid: true, error: error instanceof Error ? error.message : String(error) };
  }
}
