/* Kidai Plugin Remote — client logic (no framework, no build step) */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    env: null,
    plugins: [],
    orphans: [],
    warnings: [],
    profile: "desktop",
    launchActive: false,
    monitor: false,
    monitorIsolating: false,
    viewMode: "wide",
    confirmingId: null,
    confirmTimer: null,
    busyOrphan: null,
    confirmOrphanDelete: null,
    confirmUninstall: null,
    uninstallTimer: null,
    snapshots: [],
  };

  const PREFS_KEY = "kpr:prefs:v1";
  const THEME_KEY = "kpr:theme:v1";
  const SEV_LABELS = { error: "高危", warn: "警告", info: "提示" };

  // ---------------------------------------------------------------- theme
  const THEME_NAMES = ["dark", "light", "ds-blue", "sage", "violet", "teal", "coral", "rose"];
  const THEME_ALIASES = { "light-ds": "ds-blue", "light-sage": "sage" };
  function applyTheme(theme) {
    const value = THEME_NAMES.includes(theme) ? theme : (THEME_ALIASES[theme] ?? "dark");
    document.documentElement.dataset.theme = value;
    try {
      window.localStorage.setItem(THEME_KEY, value);
    } catch {
      /* storage unavailable */
    }
    // Persist server-side too: the standalone client binds a fresh random
    // port on every launch, which changes the origin and would otherwise
    // reset browser localStorage every time.
    try {
      api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: value }),
      }).catch(() => {});
    } catch {
      /* fire-and-forget */
    }
    document.querySelectorAll(".theme-swatch").forEach((swatch) => {
      swatch.classList.toggle("active", swatch.dataset.theme === value);
    });
  }

  // ---------------------------------------------------------------- prefs
  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw !== null) return JSON.parse(raw);
    } catch {
      /* storage unavailable */
    }
    return {};
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          viewMode: state.viewMode,
          search: $("search").value,
          sort: $("sort").value,
          origin: $("origin").value,
          statusFilter: $("status-filter").value,
        }),
      );
    } catch {
      /* storage unavailable */
    }
  }

  // ---------------------------------------------------------------- utils
  function fmtLocalTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(kind, text, ms) {
    const root = $("toast-root");
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = text;
    root.appendChild(node);
    setTimeout(() => {
      node.style.opacity = "0";
      node.style.transition = "opacity .25s";
      setTimeout(() => node.remove(), 260);
    }, ms ?? (kind === "error" ? 6000 : 3200));
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    return payload;
  }

  function letterColor(name) {
    const colors = ["#5b8def", "#7c6fe0", "#4fb3a6", "#e0963f", "#d96f8b", "#6aa84f", "#a97bd0", "#5aa7c8"];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return colors[hash % colors.length];
  }

  // ---------------------------------------------------------------- env
  async function refreshEnv() {
    try {
      const payload = await api("/api/env");
      state.env = payload.env;
      state.profile = payload.env.activeProfile || "desktop";
      $("env-profile").textContent = `profile: ${state.profile}`;
      $("env-home").title = payload.env.dshHome;
      $("env-home").textContent = `DSH_HOME: ${payload.env.dshHome}`;
      const pill = $("run-pill");
      if (payload.env.desktopRunning) {
        pill.textContent = "● DSH Desktop 运行中";
        pill.className = "pill pill-running";
      } else {
        pill.textContent = "○ DSH Desktop 未运行";
        pill.className = "pill pill-stopped";
      }
      const guard = $("guard-chip");
      guard.hidden = false;
      guard.textContent = payload.guardInstalled ? "✓ 内部守护已装" : "内部守护未装";
      guard.className = "chip " + (payload.guardInstalled ? "chip-ok" : "chip-warn");
      const snap = $("snap-chip");
      snap.hidden = false;
      snap.textContent = payload.pendingSnapshots > 0 ? `待确认快照 ${payload.pendingSnapshots}` : "快照正常";
      snap.className = "chip " + (payload.pendingSnapshots > 0 ? "chip-warn" : "chip-muted");
      return payload.env;
    } catch (error) {
      $("run-pill").textContent = "环境检测失败";
      return null;
    }
  }

  // ---------------------------------------------------------------- list
  async function refreshPlugins() {
    const btn = $("btn-refresh");
    btn.disabled = true;
    btn.textContent = "⟳ 刷新中…";
    $("plugin-count").classList.add("refreshing");
    try {
      const payload = await api(`/api/plugins?profile=${encodeURIComponent(state.profile)}`);
      state.plugins = payload.view.plugins ?? [];
      state.orphans = Array.isArray(payload.orphans) ? payload.orphans : [];
      state.warnings = payload.warnings ?? [];
      const problems = [
        ...(payload.layerProblems ?? []),
        ...(payload.profilePatchProblem ? [{ message: payload.profilePatchProblem }] : []),
        ...(payload.homePatchProblem ? [{ message: payload.homePatchProblem }] : []),
      ];
      renderNotice(problems);
      renderList();
      renderOrphans();
    } catch (error) {
      toast("error", `获取插件列表失败：${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "⟳ 强制刷新";
      $("plugin-count").classList.remove("refreshing");
    }
  }

  function renderNotice(problems) {
    const notice = $("notice");
    if (problems.length > 0) {
      notice.hidden = false;
      notice.className = "notice error";
      notice.innerHTML = `<strong>组合层存在问题：</strong><br>${problems
        .map((item) => esc(item.message))
        .join("<br>")}`;
    } else if (state.warnings.length > 0) {
      notice.hidden = false;
      notice.className = "notice warn";
      notice.textContent = `${state.warnings.length} 条 patch 警告（未命中的条目等），详见「启动前预检分析」。`;
    } else {
      notice.hidden = true;
    }
  }

  function visiblePlugins() {
    const query = $("search").value.trim().toLowerCase();
    const origin = $("origin").value;
    const statusFilter = $("status-filter").value;
    const sort = $("sort").value;
    let rows = state.plugins.filter((plugin) => {
      if (origin === "third-party" && plugin.origin !== "third-party") return false;
      if (origin === "native" && plugin.origin !== "native") return false;
      if (statusFilter === "enabled" && !plugin.enabled) return false;
      if (statusFilter === "disabled" && plugin.enabled) return false;
      if (query.length > 0) {
        const haystack = `${plugin.name} ${plugin.entryId} ${plugin.description} ${plugin.version}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    const sorted = [...rows];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "status") sorted.sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? -1 : 1));
    else sorted.sort((a, b) => (a.installedAt ?? "") < (b.installedAt ?? "") ? 1 : (a.installedAt ?? "") > (b.installedAt ?? "") ? -1 : a.name.localeCompare(b.name));
    return sorted;
  }

  function renderList() {
    const list = $("plugin-list");
    const rows = visiblePlugins();
    const all = state.plugins;
    const thirdParty = all.filter((p) => p.origin === "third-party").length;
    const native = all.length - thirdParty;
    const enabled = all.filter((p) => p.enabled).length;
    $("plugin-count").innerHTML =
      `<span class="count-item count-total">${all.length} 个插件</span>` +
      `<span class="count-item count-third">第三方 ${thirdParty}</span>` +
      `<span class="count-item count-native">原生 ${native}</span>` +
      `<span class="count-item count-on">已启用 ${enabled}</span>` +
      `<span class="count-item count-off">已停用 ${all.length - enabled}</span>` +
      (rows.length !== all.length ? `<span class="count-item count-filter">筛选后 ${rows.length}</span>` : "");
    list.className = `plugin-list ${state.viewMode}`;
    if (rows.length === 0) {
      const searching = $("search").value.trim().length > 0 || $("origin").value !== "all" || $("status-filter").value !== "all";
      list.innerHTML = `<li class="empty"><div class="empty-icon" aria-hidden="true">${state.plugins.length === 0 ? "!" : "⌕"}</div><p>${
        state.plugins.length === 0
          ? "未读取到插件（组合层问题见上方提示）"
          : searching
            ? "没有匹配的插件，试试放宽筛选条件"
            : "暂无插件"
      }</p></li>`;
      return;
    }
    list.innerHTML = rows
      .map((plugin) => {
        const thirdParty = plugin.origin === "third-party";
        const originBadge = thirdParty
          ? `<span class="badge badge-third">第三方</span>`
          : `<span class="badge badge-native">原生</span>`;
        const statusBadge = plugin.enabled
          ? `<span class="badge badge-enabled">已启用</span>`
          : `<span class="badge badge-disabled">已停用</span>`;
        const entryWarnBadge = plugin.entryWarn
          ? `<span class="badge badge-entrywarn" title="声明了 dsh.bundle 但没有可加载入口文件（main/exports/index.js）。挂载它会导致 DSH 启动失败。">⚠ 无入口文件</span>`
          : "";
        const versionPill = plugin.version
          ? `<span class="badge badge-ver" title="版本">v${esc(plugin.version)}</span>`
          : "";
        const meta = [];
        if (plugin.entryId) meta.push(`条目 ${esc(plugin.entryId)}`);
        if (plugin.installedAt) meta.push(`安装于 ${esc(String(plugin.installedAt).slice(0, 10))}`);
        const uninstallBtn = thirdParty
          ? `<button type="button" class="btn btn-ghost btn-sm uninstall-btn" data-action="uninstall" data-name="${esc(plugin.name)}">卸载</button>`
          : "";
        return `<li class="plugin-card ${thirdParty ? "third-party" : "native"} ${plugin.enabled ? "" : "disabled"}" data-entry="${esc(plugin.entryId)}">
          <span class="avatar ${thirdParty ? "avatar-third" : "avatar-native"}" style="background:${letterColor(plugin.name)}">${esc(plugin.name.charAt(0).toUpperCase())}</span>
          <div class="card-main">
            <div class="card-title-row">
              <span class="card-title" title="${esc(plugin.name)}">${esc(plugin.name)}</span>
              ${versionPill}${originBadge}${statusBadge}${entryWarnBadge}
            </div>
            <p class="card-desc">${esc(plugin.description || "—")}</p>
            <div class="card-meta">${meta.join(" · ")}</div>
            <button type="button" class="card-path" data-action="copy-path" data-path="${esc(plugin.path)}" title="点击复制路径">📁 ${esc(plugin.path)}</button>
          </div>
          <div class="card-actions">
            <button type="button" class="btn toggle-btn ${plugin.enabled ? "enabled" : "disabled"}" data-action="toggle" data-entry-id="${esc(plugin.entryId)}" data-enabled="${plugin.enabled}">
              ${plugin.enabled ? "停用" : "启用"}
            </button>
            ${uninstallBtn}
          </div>
        </li>`;
      })
      .join("");
  }

  /** Orphan section: files that exist but are not mounted as loader entries. */
  function renderOrphans() {
    const section = $("orphans-section");
    const list = $("orphans-list");
    if (state.orphans.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    $("orphans-count").textContent = state.orphans.length;
    list.innerHTML = state.orphans
      .map((orphan) => {
        const busy = state.busyOrphan === orphan.name;
        let reasonBadge;
        if (!orphan.declared) {
          reasonBadge = `<span class="badge badge-third" title="该包不在依赖清单中">文件存在但未声明依赖</span>`;
        } else if (orphan.desktopDisabled) {
          reasonBadge = `<span class="badge badge-disabled" title="该包在依赖清单中，但被 DSH Desktop 的插件管理停用">桌面插件管理已停用</span>`;
        } else {
          reasonBadge = `<span class="badge badge-disabled" title="该包在依赖清单中但未挂载">已声明依赖但未挂载</span>`;
        }
        const entryBadge = orphan.entryOk === false
          ? `<span class="badge badge-entrywarn" title="声明了 dsh.bundle 但没有可加载入口文件">⚠ 无入口文件</span>`
          : "";
        let actions = "";
        if (orphan.declared) {
          actions =
            `<button type="button" class="btn btn-sm orphan-mount" data-action="orphan-mount" data-name="${esc(orphan.name)}" ${busy ? "disabled" : ""}>${busy ? "…" : "启用"}</button>` +
            `<button type="button" class="btn btn-sm btn-danger-soft orphan-uninstall" data-action="orphan-uninstall" data-name="${esc(orphan.name)}" ${busy ? "disabled" : ""}>${state.confirmOrphanDelete === orphan.name ? "确认卸载？" : "卸载"}</button>`;
        } else {
          actions =
            `<button type="button" class="btn btn-sm btn-danger-soft orphan-delete" data-action="orphan-delete" data-name="${esc(orphan.name)}" ${busy ? "disabled" : ""}>${state.confirmOrphanDelete === orphan.name ? "确认删除？" : "删除文件"}</button>`;
        }
        return `<li class="orphan-row" data-name="${esc(orphan.name)}">
          <span class="avatar avatar-orphan" aria-hidden="true">?</span>
          <div class="card-main">
            <div class="card-title-row">
              <span class="card-title">${esc(orphan.name)}</span>
              ${reasonBadge}${entryBadge}
            </div>
            <div class="card-meta">${esc(orphan.path)}</div>
          </div>
          <div class="card-actions orphan-actions">${actions}</div>
        </li>`;
      })
      .join("");
  }

  // ---------------------------------------------------------------- actions
  async function onToggle(entryId, currentlyEnabled) {
    const targetEnabled = !currentlyEnabled;
    // 停用 requires a second confirm click (auto-reverts after 5s).
    if (!targetEnabled) {
      if (state.confirmingId === entryId) {
        clearConfirmTimer();
      } else {
        state.confirmingId = entryId;
        const button = document.querySelector(`.toggle-btn[data-entry-id="${CSS.escape(entryId)}"]`);
        if (button) {
          button.textContent = "确认停用？";
          button.classList.add("confirming");
        }
        if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
        state.confirmTimer = setTimeout(() => {
          state.confirmingId = null;
          state.confirmTimer = null;
          const current = document.querySelector(`.toggle-btn[data-entry-id="${CSS.escape(entryId)}"]`);
          if (current) {
            current.textContent = "停用";
            current.classList.remove("confirming");
          }
        }, 5000);
        return;
      }
    }
    clearConfirmTimer();
    const button = document.querySelector(`.toggle-btn[data-entry-id="${CSS.escape(entryId)}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = "提交中…";
    }
    try {
      const payload = await api("/api/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, enabled: targetEnabled, profile: state.profile }),
      });
      if (payload.result?.ok) {
        toast("success", payload.result.message);
        state.plugins = payload.view.plugins ?? state.plugins;
        renderList();
      } else {
        toast("error", payload.result?.message ?? "操作失败");
      }
    } catch (error) {
      toast("error", `操作失败：${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = targetEnabled ? "停用" : "启用";
      }
    }
  }

  function clearConfirmTimer() {
    state.confirmingId = null;
    if (state.confirmTimer !== null) {
      clearTimeout(state.confirmTimer);
      state.confirmTimer = null;
    }
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      toast("success", "路径已复制到剪贴板");
    } catch {
      toast("error", "复制失败（浏览器限制剪贴板权限）");
    }
  }

  // ---------------------------------------------------------- plugin mgmt
  /** Re-fetch the list + orphans after a management action. */
  async function refreshAfterAction() {
    try {
      const payload = await api(`/api/plugins?profile=${encodeURIComponent(state.profile)}`);
      state.plugins = payload.view.plugins ?? [];
      state.orphans = Array.isArray(payload.orphans) ? payload.orphans : [];
      renderList();
      renderOrphans();
    } catch {
      /* keep the current view */
    }
  }

  async function onMountOrphan(name) {
    if (state.busyOrphan !== null) return;
    state.busyOrphan = name;
    renderOrphans();
    try {
      const payload = await api("/api/orphans/mount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: name, profile: state.profile }),
      });
      if (payload.result?.ok) toast("success", payload.result.message);
      else toast("error", payload.result?.message ?? "挂载失败");
      await refreshAfterAction();
    } catch (error) {
      toast("error", `挂载失败：${error.message}`);
    } finally {
      state.busyOrphan = null;
      renderOrphans();
    }
  }

  async function onRemoveOrphan(name, declared) {
    if (state.busyOrphan !== null) return;
    if (state.confirmOrphanDelete !== name) {
      state.confirmOrphanDelete = name;
      renderOrphans();
      setTimeout(() => {
        if (state.confirmOrphanDelete === name) {
          state.confirmOrphanDelete = null;
          renderOrphans();
        }
      }, 5000);
      return;
    }
    state.confirmOrphanDelete = null;
    state.busyOrphan = name;
    renderOrphans();
    try {
      const payload = await api(declared ? "/api/uninstall" : "/api/orphans/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: name, profile: state.profile }),
      });
      if (payload.result?.ok) toast("success", payload.result.message);
      else toast("error", payload.result?.message ?? "删除失败");
      await refreshAfterAction();
    } catch (error) {
      toast("error", `删除失败：${error.message}`);
    } finally {
      state.busyOrphan = null;
      renderOrphans();
    }
  }

  async function onUninstall(name) {
    if (state.confirmUninstall !== name) {
      state.confirmUninstall = name;
      const button = document.querySelector(`.uninstall-btn[data-name="${CSS.escape(name)}"]`);
      if (button) {
        button.textContent = "确认卸载？";
        button.classList.add("confirming");
      }
      if (state.uninstallTimer !== null) clearTimeout(state.uninstallTimer);
      state.uninstallTimer = setTimeout(() => {
        state.confirmUninstall = null;
        state.uninstallTimer = null;
        const current = document.querySelector(`.uninstall-btn[data-name="${CSS.escape(name)}"]`);
        if (current) {
          current.textContent = "卸载";
          current.classList.remove("confirming");
        }
      }, 5000);
      return;
    }
    state.confirmUninstall = null;
    if (state.uninstallTimer !== null) {
      clearTimeout(state.uninstallTimer);
      state.uninstallTimer = null;
    }
    const button = document.querySelector(`.uninstall-btn[data-name="${CSS.escape(name)}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = "卸载中…";
    }
    try {
      const payload = await api("/api/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: name, profile: state.profile }),
      });
      if (payload.result?.ok) toast("success", payload.result.message);
      else toast("error", payload.result?.message ?? "卸载失败");
      await refreshAfterAction();
    } catch (error) {
      toast("error", `卸载失败：${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "卸载";
        button.classList.remove("confirming");
      }
    }
  }

  function renderLaunchStatus(payload) {
    const box = $("launch-status");
    const current = payload.current;
    if (!payload.active || !current) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const stageText = { spawning: "准备中…", monitoring: "正在启动并监控 DSH…", success: "启动成功", failed: "启动失败" };
    $("launch-stage-text").textContent = stageText[current.stage] ?? current.stage;
    const events = $("launch-events");
    events.innerHTML = current.events
      .slice(-12)
      .map((event) => `<li>${esc(String(event.stage))} · ${esc(event.detail ?? "")}</li>`)
      .join("");
    if (current.result) {
      events.innerHTML += current.result.ok
        ? `<li class="success">✓ ${esc(current.result.message)}</li>`
        : `<li class="launch-failed">✗ ${esc(current.result.message)}</li>`;
    }
  }

  async function pollLaunch() {
    try {
      const payload = await api("/api/launch-status");
      state.launchActive = payload.active;
      renderLaunchStatus(payload);
      if (!payload.active && payload.current?.result) {
        const result = payload.current.result;
        if (result.ok) {
          enterMonitor(result);
        } else {
          leaveMonitor();
          showReport({ title: "启动失败 — 诊断报告", launch: result });
        }
        // one-shot: clear the finished result marker after rendering
        return;
      }
    } catch {
      /* transient */
    }
  }

  async function onLaunch(mode) {
    const running = state.env?.desktopRunning;
    if (running) {
      toast("error", "DSH Desktop 正在运行：请先退出 DSH，再执行启动。");
      return;
    }
    if (state.launchActive) {
      toast("warn", "已有启动任务在进行中。");
      return;
    }
    try {
      const payload = await api("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: state.profile, mode }),
      });
      if (payload.skipped) {
        toast("error", payload.message ?? "无法启动");
        return;
      }
      if (payload.accepted) {
        if ((payload.preflight?.findings ?? []).some((finding) => finding.severity === "error")) {
          const errors = payload.preflight.findings.filter((finding) => finding.severity === "error");
          toast("warn", `预检发现 ${errors.length} 个高危问题；已按你的要求继续启动（启动失败会自动给出报告）。`);
        } else {
          toast("info", mode === "isolated" ? "正在以隔离模式启动 DSH…" : "正在启动 DSH Desktop…");
        }
        state.launchActive = true;
        $("launch-status").hidden = false;
        pollLaunch();
      }
    } catch (error) {
      toast("error", `启动请求失败：${error.message}`);
    }
  }

  function enterMonitor(result) {
    state.monitor = true;
    const isolating = result.mode === "isolated" || result.isolating;
    state.monitorIsolating = isolating;
    $("monitor").hidden = false;
    $("launch-status").hidden = true;
    $("monitor-title").textContent = isolating ? "DSH 已启动（隔离运行中）" : "DSH 已启动";
    let detail = `${result.pid ? `PID ${result.pid} · ` : ""}${result.message ?? ""}`;
    if (result.autoExit) {
      detail += "\n⏱ 按「自动关闭」设置，约 10 秒后管理器将自动退出（DSH 保持运行）。";
    } else if (isolating) {
      detail += "\nDSH 退出后会自动恢复原插件配置；隔离仅本次启动有效。";
    }
    $("monitor-detail").textContent = detail;
    $("btn-abort-isolate").style.display = isolating ? "" : "none";
    toast("success", "DSH 启动成功，管理器自动最小化，继续后台监控。", 6000);
    // auto-minimize the manager console (best-effort)
    api("/api/minimize", { method: "POST" }).catch(() => {});
  }

  function leaveMonitor() {
    state.monitor = false;
    state.monitorIsolating = false;
    $("monitor").hidden = true;
  }

  /** The server (terminal) exited: close this app window to keep UI ↔ terminal
   *  lifecycle linked. The UI is opened as a browser app window, so close() works;
   *  if a plain tab blocks it, leave a hint telling the user to close it. */
  function showDisconnected() {
    if ($("disconnected-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "disconnected-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:rgba(10,14,22,.94);color:#e8ecf4;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;" +
      "font-size:14px;text-align:center;padding:24px;";
    overlay.innerHTML =
      `<div style="font-size:26px">🪫</div>` +
      `<div>管理器终端已退出，本窗口将自动关闭。</div>` +
      `<div style="color:#8b93a3;font-size:12.5px">若窗口没有自动关闭，请手动关闭它；需要再次使用请重新运行启动脚本。</div>`;
    document.body.appendChild(overlay);
    try {
      window.close();
    } catch {
      /* blocked by the browser: the overlay above stays as a fallback hint */
    }
  }

  async function onAbortIsolate() {
    try {
      const payload = await api("/api/abort-isolation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: state.profile }),
      });
      if (payload.ok) {
        toast("success", payload.message ?? "已结束隔离：原插件配置已恢复（下次启动 DSH 生效）。");
        leaveMonitor();
        refreshPlugins();
      } else {
        toast("error", payload.message ?? "结束隔离失败");
      }
    } catch (error) {
      toast("error", `结束隔离失败：${error.message}`);
    }
  }

  // ---------------------------------------------------------------- report modal
  /** Abort controller for the in-flight preflight request (closed = aborted). */
  let preflightAbort = null;

  function showReport({ title, analysis, launch, loading }) {
    $("report-title").textContent = title ?? "启动前预检分析";
    const body = $("report-body");
    if (loading === true) {
      body.innerHTML =
        `<div class="finding info">` +
        `<h4><span class="sev">进行中</span>正在分析…</h4>` +
        `<p>正在运行只读预检（本地组合校验 + dsh --dump-config），通常需要几秒；CLI 校验使用较慢的运行时时会稍久。</p>` +
        `</div>` +
        `<div class="report-actions">` +
        `<button type="button" class="btn btn-ghost btn-sm" data-action="close-report">关闭（中止分析）</button>` +
        `</div>`;
      $("report-modal").hidden = false;
      body.querySelector('[data-action="close-report"]')?.addEventListener("click", closeReport);
      return;
    }
    const findings = analysis?.findings ?? launch?.findings ?? [];
    const verdict = analysis?.verdict ?? launch?.verdict ?? "";
    const html = [];
    if (verdict) {
      const cls = (analysis?.ok === true || launch?.ok === true) ? "ok" : verdict.includes("高危") ? "fail" : "warn";
      html.push(`<div class="verdict ${cls}">结论：${esc(verdict)}</div>`);
    }
    if (launch?.evidence) {
      const evidence = launch.evidence;
      html.push(`<div class="finding error"><h4><span class="sev">运行证据</span>启动失败信息</h4>`);
      html.push(`<p>${esc(launch.message ?? "")}</p>`);
      if (evidence.exitCode !== undefined && evidence.exitCode !== null) html.push(`<p>退出码：${esc(evidence.exitCode)}</p>`);
      if (evidence.selectionState) {
        html.push(`<p>profile-selection：active=${esc(evidence.selectionState.active)}，lastKnownGood=${esc(evidence.selectionState.lastKnownGood)}</p>`);
      }
      if (evidence.stderr) html.push(`<p class="src">stderr：${esc(evidence.stderr)}</p>`);
      if (evidence.logErrors?.length) {
        html.push(`<div class="dump-block">${evidence.logErrors.map((line) => esc(line)).join("\n")}</div>`);
      }
      if (evidence.crashEvidence?.length) {
        html.push(`<p class="src">崩溃转储：${evidence.crashEvidence.map((name) => esc(name)).join(", ")}</p>`);
      }
      html.push(`</div>`);
    }
    if (findings.length === 0) {
      html.push(`<div class="finding info"><h4><span class="sev">提示</span>未发现明显问题</h4><p>当前组合层健康。</p></div>`);
    }
    for (const finding of findings) {
      html.push(`<div class="finding ${esc(finding.severity)}">`);
      html.push(`<h4><span class="sev">${esc(SEV_LABELS[finding.severity] ?? finding.severity)}</span>${esc(finding.title)}</h4>`);
      if (finding.detail) html.push(`<p>${esc(finding.detail)}</p>`);
      if (finding.fix) html.push(`<p class="fix">💡 修复建议：${esc(finding.fix)}</p>`);
      if (finding.source) html.push(`<p class="src">来源：${esc(finding.source)}</p>`);
      html.push(`</div>`);
    }
    html.push(`<div class="report-actions">`);
    html.push(`<button type="button" class="btn btn-ghost btn-sm" data-action="copy-report">复制报告</button>`);
    html.push(`<button type="button" class="btn btn-ghost btn-sm" data-action="close-report">关闭</button>`);
    html.push(`</div>`);
    body.innerHTML = html.join("");
    $("report-modal").hidden = false;
    body.querySelector('[data-action="copy-report"]')?.addEventListener("click", () => {
      const text = body.innerText;
      navigator.clipboard?.writeText(text).then(
        () => toast("success", "报告已复制"),
        () => toast("error", "复制失败"),
      );
    });
    body.querySelector('[data-action="close-report"]')?.addEventListener("click", closeReport);
  }

  function closeReport() {
    $("report-modal").hidden = true;
    if (preflightAbort !== null) {
      try {
        preflightAbort.abort();
      } catch {
        /* already aborted */
      }
      preflightAbort = null;
    }
  }

  async function onPreflight() {
    closeReport();
    const controller = new AbortController();
    preflightAbort = controller;
    showReport({ title: `启动前预检分析 · profile: ${state.profile}`, loading: true });
    try {
      const payload = await api(`/api/preflight?profile=${encodeURIComponent(state.profile)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      showReport({
        title: `启动前预检分析 · profile: ${state.profile}`,
        analysis: payload.analysis,
      });
      if (payload.dump?.ok === false && !controller.signal.aborted) {
        const body = $("report-body");
        const warn = document.createElement("div");
        warn.className = "finding warn";
        warn.innerHTML =
          `<h4><span class="sev">警告</span>CLI 组合校验（dsh --dump-config）失败</h4>` +
          `<p>${esc(payload.dump.stderr || "未知错误")}</p>` +
          `<p class="fix">💡 修复建议：查看下方 dump 输出，或先用「隔离运行」验证原生基线。</p>`;
        body.insertBefore(warn, body.firstChild);
      }
      const body = $("report-body");
      const count = document.createElement("p");
      count.className = "src";
      count.textContent = `组合树条目数：${payload.composedRows?.length ?? "?"} · CLI 校验运行时：${payload.dump?.nodeInfo ?? "不可用"}`;
      body.appendChild(count);
      const dump = document.createElement("div");
      dump.className = "dump-block";
      dump.textContent =
        `$ dsh --profile ${state.profile} --dump-config\n` +
        (payload.dump?.stdout ?? "(无输出)") +
        (payload.dump?.stderr ? `\n\n[stderr]\n${payload.dump.stderr}` : "");
      body.appendChild(dump);
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) return;
      showReport({
        title: `启动前预检分析 · profile: ${state.profile}`,
        analysis: {
          verdict: "预检请求失败",
          ok: false,
          findings: [
            {
              severity: "error",
              title: "预检请求失败",
              detail: error instanceof Error ? error.message : String(error),
              fix: "请重试；若 CLI 校验持续卡住，可先关闭（中止），再查看服务器控制台的运行记录。",
            },
          ],
        },
      });
    } finally {
      if (preflightAbort === controller) preflightAbort = null;
    }
  }

  // ---------------------------------------------------------------- tabs
  const TAB_NAMES = { installed: "已安装插件", snapshots: "快照与回滚", settings: "设置" };
  const SNAP_STATUS = {
    pending: { label: "待确认", cls: "snap-pending" },
    verified: { label: "已验证", cls: "snap-verified" },
    failed: { label: "启动失败", cls: "snap-failed" },
    "rolled-back": { label: "已回滚", cls: "snap-rolled" },
  };
  const TRIGGER_LABELS = { launch: "启动 DSH 前", toggle: "启停变更", mutate: "配置变更", manual: "手动", rollback: "回滚前" };

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
    $("tab-installed").hidden = name !== "installed";
    $("tab-snapshots").hidden = name !== "snapshots";
    $("tab-settings").hidden = name !== "settings";
    $("launch-column").hidden = name !== "installed";
    document.querySelector(".layout").classList.toggle("solo", name !== "installed");
    if (name === "snapshots") refreshSnapshots();
    if (name === "settings") refreshSettings();
  }

  let confirmRollbackId = null;
  let rollbackTimer = null;
  let noteTargetId = null;

  async function refreshSnapshots() {
    const list = $("snapshot-list");
    try {
      const payload = await api(`/api/snapshots?profile=${encodeURIComponent(state.profile)}`);
      const snaps = payload.snapshots ?? [];
      state.snapshots = snaps;
      if (snaps.length === 0) {
        list.innerHTML = `<li class="empty"><div class="empty-icon" aria-hidden="true">◇</div><p>还没有快照。启动 DSH 或做一次配置变更后，这里会保留「待确认」快照。</p></li>`;
        return;
      }
      list.innerHTML = snaps
        .map((snap) => {
          const status = SNAP_STATUS[snap.status] ?? { label: snap.status, cls: "snap-pending" };
          const when = fmtLocalTime(snap.createdAt);
          const packages = Object.keys(snap.packages ?? {}).length;
          const size = snap.size > 0 ? ` · ${(snap.size / 1024).toFixed(0)} KB` : "";
          const note = snap.note ? ` · <span class="snap-note" title="备注：${esc(snap.note)}">${esc(snap.note)}</span>` : "";
          const noteBtn = `<button type="button" class="btn btn-sm btn-ghost" data-action="snapshot-note" data-id="${esc(snap.id)}" title="添加/修改备注">备注</button>`;
          // A snapshot stays a valid rollback target even after it has been
          // used once (its recorded state is intact) — allow re-rolling-back.
          const rollbackable = snap.status === "verified" || snap.status === "pending" || snap.status === "failed" || snap.status === "rolled-back";
          const rollbackBtns = rollbackable
            ? `<button type="button" class="btn btn-sm btn-danger-soft rollback-btn ${confirmRollbackId === snap.id ? "confirming" : ""}" data-action="rollback" data-id="${esc(snap.id)}">${confirmRollbackId === snap.id ? "确认回滚？" : "回滚"}</button>` +
              `<button type="button" class="btn btn-sm btn-danger-soft rollback-btn" data-action="rollback-disable" data-id="${esc(snap.id)}" title="回滚并自动禁用快照之后新增/变更的插件（崩溃嫌疑）">回滚+禁用嫌疑</button>`
            : "";
          return `<li class="snapshot-row">
            <div class="snap-main">
              <div class="card-title-row">
                <span class="snap-id" title="${esc(snap.id)}">${esc(snap.id)}</span>
                <span class="badge ${status.cls}">${status.label}</span>
                <span class="badge badge-ver">${esc(TRIGGER_LABELS[snap.trigger] ?? snap.trigger)}</span>
              </div>
              <div class="card-meta">${when} · 包 ${packages} 个${size}${note}</div>
            </div>
            <div class="card-actions snap-actions">${noteBtn}${rollbackBtns}</div>
          </li>`;
        })
        .join("");
    } catch (error) {
      list.innerHTML = `<li class="empty">快照读取失败：${esc(error.message)}</li>`;
    }
  }

  async function onRollback(id, disableSuspected) {
    if (confirmRollbackId !== id) {
      confirmRollbackId = id;
      refreshSnapshots();
      if (rollbackTimer !== null) clearTimeout(rollbackTimer);
      rollbackTimer = setTimeout(() => {
        confirmRollbackId = null;
        refreshSnapshots();
      }, 6000);
      return;
    }
    confirmRollbackId = null;
    if (rollbackTimer !== null) {
      clearTimeout(rollbackTimer);
      rollbackTimer = null;
    }
    try {
      const payload = await api("/api/snapshots/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, profile: state.profile, disableSuspected: disableSuspected === true }),
      });
      if (payload.result?.ok) {
        toast("success", payload.result.message);
        refreshSnapshots();
        refreshPlugins();
      } else {
        toast("error", payload.result?.message ?? "回滚失败");
      }
    } catch (error) {
      toast("error", `回滚失败：${error.message}`);
    }
  }

  // ---------------------------------------------------------------- snapshot note
  function openNoteModal(id) {
    noteTargetId = id;
    const snap = (state.snapshots ?? []).find((s) => s.id === id);
    $("note-input").value = snap?.note ?? "";
    $("note-modal").hidden = false;
    setTimeout(() => $("note-input").focus(), 0);
  }

  async function saveNote() {
    if (noteTargetId === null) return;
    const id = noteTargetId;
    const note = $("note-input").value.trim();
    $("note-modal").hidden = true;
    noteTargetId = null;
    try {
      const payload = await api("/api/snapshots/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, profile: state.profile, note }),
      });
      if (payload.result?.ok) {
        toast("success", note.length > 0 ? "备注已保存" : "备注已清除");
      } else {
        toast("error", payload.result?.message ?? "备注保存失败");
      }
    } catch (error) {
      toast("error", `备注保存失败：${error.message}`);
    }
    refreshSnapshots();
  }

  function closeNoteModal() {
    $("note-modal").hidden = true;
    noteTargetId = null;
  }

  async function refreshSettings() {
    try {
      const [settingsPayload, envPayload] = await Promise.all([
        api("/api/settings"),
        api("/api/env"),
      ]);
      $("set-snapshot-launch").checked = settingsPayload.settings.snapshotOnLaunch === true;
      $("set-snapshot-mutate").checked = settingsPayload.settings.snapshotOnMutate === true;
      $("set-keep").value = settingsPayload.settings.keepSnapshots ?? 12;
      const afterLaunch = settingsPayload.settings.afterLaunch ?? "minimize";
      document.querySelectorAll('input[name="after-launch"]').forEach((radio) => {
        radio.checked = radio.value === afterLaunch;
      });
      const env = envPayload.env;
      const rows = [
        ["DSH_HOME", env.dshHome],
        ["DSH Desktop 安装", env.install ?? "未找到（设置 DSH_DESKTOP_DIR）"],
        ["活跃 profile", env.activeProfile],
        ["桌面用户数据", env.userData],
        ["日志目录", env.logsDir],
        ["管理器数据目录", settingsPayload.managerDataDir],
        ["管理器地址", `http://127.0.0.1:${location.port}`],
        ["Node 版本", `${env.nodeVersion}（${env.systemNode}）`],
      ];
      $("settings-info").innerHTML = rows
        .map(([key, value]) => `<dt>${esc(key)}</dt><dd title="${esc(value)}">${esc(value)}</dd>`)
        .join("");
      const guard = $("guard-status");
      guard.textContent = settingsPayload.guardInstalled
        ? "已安装：每次 DSH 成功启动会把「待确认」快照标记为「已验证」，实现「保留到下次成功运行」。可用 /kidai-snapshot 命令只读查看。"
        : "未安装：装后可在 DSH 内部也确认快照。运行 scripts\\install-guard.ps1 安装（需重启 DSH 生效）。";
      guard.className = settingsPayload.guardInstalled ? "hint hint-ok" : "hint hint-warn";
      $("btn-guard-dir").dataset.path = `${env.dshHome}\\profiles\\${env.activeProfile}\\node_modules\\kidai-snapshot-guard`;
      $("btn-snapshots-dir").dataset.path = `${env.dshHome}\\.kidai-snapshots`;
    } catch (error) {
      toast("error", `设置读取失败：${error.message}`);
    }
  }

  async function openPath(path) {
    try {
      await api("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch {
      toast("error", "无法打开目录");
    }
  }

  // ---------------------------------------------------------------- activity
  async function refreshActivity() {
    try {
      const payload = await api("/api/logs");
      const list = $("activity");
      list.innerHTML = payload.activity
        .slice(-40)
        .map((entry) => {
          const cls = entry.level === "error" ? "error" : entry.level === "info" ? "" : "success";
          const time = fmtLocalTime(entry.at).slice(11, 19);
          return `<li class="${cls}">${time} ${esc(entry.level)} ${esc(entry.message)}</li>`;
        })
        .join("");
    } catch {
      /* transient */
    }
  }

  // ---------------------------------------------------------------- events
  $("theme-picker").addEventListener("click", (event) => {
    const swatch = event.target.closest(".theme-swatch");
    if (swatch) applyTheme(swatch.dataset.theme);
  });
  $("btn-create-shortcut").addEventListener("click", async () => {
    const btn = $("btn-create-shortcut");
    if (!window.kprClient?.createShortcut) {
      toast("info", "「发送快捷方式」仅独立 Client 版可用；经典版请手动创建快捷方式。");
      return;
    }
    btn.disabled = true;
    btn.textContent = "选择位置…";
    try {
      const result = await window.kprClient.createShortcut();
      if (result?.ok) {
        toast("success", `已创建快捷方式：${result.path}`);
      } else if (result?.canceled) {
        /* user closed the folder picker */
      } else {
        toast("error", result?.error ?? "创建快捷方式失败");
      }
    } catch (error) {
      toast("error", `创建快捷方式失败：${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "发送快捷方式";
    }
  });
  $("btn-refresh").addEventListener("click", () => refreshPlugins());
  $("btn-launch").addEventListener("click", () => onLaunch("desktop"));
  $("btn-isolate").addEventListener("click", () => onLaunch("isolated"));
  $("btn-preflight").addEventListener("click", onPreflight);
  $("btn-abort-isolate").addEventListener("click", onAbortIsolate);
  $("btn-back-list").addEventListener("click", () => leaveMonitor());
  $("report-close").addEventListener("click", closeReport);
  $("report-modal").addEventListener("click", (event) => {
    if (event.target === $("report-modal")) closeReport();
  });
  $("note-save").addEventListener("click", saveNote);
  $("note-close").addEventListener("click", closeNoteModal);
  $("note-modal").addEventListener("click", (event) => {
    if (event.target === $("note-modal")) closeNoteModal();
  });
  $("note-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveNote();
  });
  $("search-clear").addEventListener("click", () => {
    $("search").value = "";
    $("search-clear").hidden = true;
    renderList();
    savePrefs();
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  $("btn-refresh-snapshots").addEventListener("click", refreshSnapshots);
  $("import-zip").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const btn = $("btn-refresh-snapshots");
    btn.disabled = true;
    btn.textContent = "导入中…";
    try {
      const response = await fetch(`/api/snapshots/import-zip?profile=${encodeURIComponent(state.profile)}&disableSuspected=${$("import-disable").checked ? "1" : "0"}`, { method: "POST", body: file });
      const payload = await response.json().catch(() => ({}));
      const result = payload.result ?? {};
      toast(result.ok ? "success" : "error", result.message ?? "导入失败");
      if (result.ok) {
        refreshSnapshots();
        refreshPlugins();
      }
    } catch (error) {
      toast("error", `导入失败：${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "⟳ 刷新";
      event.target.value = "";
    }
  });
  $("import-env").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const btn = $("btn-refresh-snapshots");
    btn.disabled = true;
    btn.textContent = "恢复中…";
    try {
      const response = await fetch(`/api/env-restore?profile=${encodeURIComponent(state.profile)}`, { method: "POST", body: file });
      const payload = await response.json().catch(() => ({}));
      const result = payload.result ?? {};
      if (result.ok) {
        toast("success", `完整环境已恢复：${result.restored} 个文件（恢复前已备份到 .kidai-remote-backups）。请重启 DSH 生效。`);
        refreshPlugins();
      } else {
        toast("error", result.message ?? "恢复失败");
      }
    } catch (error) {
      toast("error", `恢复失败：${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "⟳ 刷新";
      event.target.value = "";
    }
  });
  $("btn-guard-dir").addEventListener("click", () => openPath($("btn-guard-dir").dataset.path ?? ""));
  $("btn-snapshots-dir").addEventListener("click", () => openPath($("btn-snapshots-dir").dataset.path ?? ""));

  const saveSettingsDebounced = (() => {
    let timer = null;
    return () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(async () => {
        const selected = document.querySelector('input[name="after-launch"]:checked');
        try {
          await api("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              snapshotOnLaunch: $("set-snapshot-launch").checked,
              snapshotOnMutate: $("set-snapshot-mutate").checked,
              keepSnapshots: Math.max(1, Math.min(100, Number($("set-keep").value) || 12)),
              afterLaunch: selected ? selected.value : "minimize",
            }),
          });
        } catch {
          /* transient */
        }
      }, 300);
    };
  })();
  $("set-snapshot-launch").addEventListener("change", saveSettingsDebounced);
  $("set-snapshot-mutate").addEventListener("change", saveSettingsDebounced);
  $("set-keep").addEventListener("change", saveSettingsDebounced);
  document.querySelectorAll('input[name="after-launch"]').forEach((radio) => {
    radio.addEventListener("change", saveSettingsDebounced);
  });

  for (const id of ["search", "sort", "origin", "status-filter"]) {
    $(id).addEventListener("input", () => {
      renderList();
      savePrefs();
    });
    $(id).addEventListener("change", () => {
      renderList();
      savePrefs();
    });
  }
  $("search").addEventListener("input", () => {
    $("search-clear").hidden = $("search").value.trim().length === 0;
    renderList();
    savePrefs();
  });

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.viewMode = btn.dataset.viewMode === "narrow" ? "narrow" : "wide";
      document.querySelectorAll(".seg-btn").forEach((other) => other.classList.toggle("active", other === btn));
      renderList();
      savePrefs();
    });
  });

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest('[data-action="toggle"]');
    if (toggle) {
      onToggle(toggle.dataset.entryId, toggle.dataset.enabled === "true");
      return;
    }
    const path = event.target.closest('[data-action="copy-path"]');
    if (path) {
      copyPath(path.dataset.path ?? "");
      return;
    }
    const mount = event.target.closest('[data-action="orphan-mount"]');
    if (mount) {
      onMountOrphan(mount.dataset.name);
      return;
    }
    const orphanDelete = event.target.closest('[data-action="orphan-delete"]');
    if (orphanDelete) {
      onRemoveOrphan(orphanDelete.dataset.name, false);
      return;
    }
    const orphanUninstall = event.target.closest('[data-action="orphan-uninstall"]');
    if (orphanUninstall) {
      onRemoveOrphan(orphanUninstall.dataset.name, true);
      return;
    }
    const uninstall = event.target.closest('[data-action="uninstall"]');
    if (uninstall) {
      onUninstall(uninstall.dataset.name);
      return;
    }
    const rollback = event.target.closest('[data-action="rollback"]');
    if (rollback) {
      onRollback(rollback.dataset.id, false);
      return;
    }
    const rollbackDisable = event.target.closest('[data-action="rollback-disable"]');
    if (rollbackDisable) {
      onRollback(rollbackDisable.dataset.id, true);
      return;
    }
    const snapshotNote = event.target.closest('[data-action="snapshot-note"]');
    if (snapshotNote) {
      openNoteModal(snapshotNote.dataset.id);
      return;
    }
  });

  // ---------------------------------------------------------------- boot
  (async function boot() {
    // apply saved theme (the inline head script already set data-theme early;
    // this syncs the picker's active state and falls back to "dark")
    let savedTheme = "dark";
    try {
      savedTheme = window.localStorage.getItem(THEME_KEY) || "dark";
    } catch {
      /* storage unavailable */
    }
    applyTheme(savedTheme);
    // restore view mode + filters from localStorage
    const prefs = loadPrefs();
    if (prefs.viewMode === "narrow") state.viewMode = "narrow";
    document.querySelectorAll(".seg-btn").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.viewMode === state.viewMode),
    );
    if (prefs.search !== undefined) $("search").value = prefs.search;
    if (prefs.sort !== undefined) $("sort").value = prefs.sort;
    if (prefs.origin !== undefined) $("origin").value = prefs.origin;
    if (prefs.statusFilter !== undefined) $("status-filter").value = prefs.statusFilter;
    $("search-clear").hidden = $("search").value.trim().length === 0;
    await refreshEnv();
    // server-side theme wins (survives random client ports / storage resets)
    try {
      const themeEnv = await api("/api/env");
      if (themeEnv.settings && typeof themeEnv.settings.theme === "string") {
        applyTheme(themeEnv.settings.theme);
      }
    } catch {
      /* server busy — keep the local pick */
    }
    await refreshPlugins();
    refreshActivity();
    // show the persisted launch report from the previous session (auto-exit mode):
    // success -> dismissible toast; failure -> persistent diagnostic modal.
    try {
      const envPayload = await api("/api/env");
      const lastReport = envPayload.lastReport;
      if (lastReport) {
        if (lastReport.ok === true) {
          toast("success", `上次启动成功：${lastReport.message ?? "DSH 已启动"}（${fmtLocalTime(lastReport.at)}）`);
        } else {
          showReport({
            title: `上次启动失败 — 诊断报告（${fmtLocalTime(lastReport.at)}）`,
            launch: lastReport,
          });
        }
        api("/api/launch-report/ack", { method: "POST" }).catch(() => {});
      }
    } catch {
      /* no report / server busy */
    }
    // re-arm monitor if a launch is recorded (e.g. manager restarted mid-isolation)
    try {
      const runState = await api("/api/run-state");
      const record = runState.runState;
      if (record?.isolating) {
        const pids = state.env?.desktopPids ?? [];
        const alive = Number.isInteger(record.pid) && pids.includes(record.pid);
        if (alive) {
          // The manager's own isolated DSH is still running — re-arm watching.
          state.monitor = true;
          state.monitorIsolating = true;
          $("monitor").hidden = false;
          $("monitor-title").textContent = "隔离运行进行中（管理器重启后重新接管）";
          $("monitor-detail").textContent = `记录于 ${record.startedAt}；DSH 退出后会自动恢复，也可手动「结束隔离」。`;
          $("btn-abort-isolate").style.display = "";
          toast("info", "检测到上一次隔离运行记录，已重新接管监控。");
        } else {
          // The recorded isolated DSH is gone (user launched DSH directly or
          // it exited while the manager was down): one-shot isolation —
          // restore the previous config and clear the record right away.
          try {
            const aborted = await api("/api/abort-isolation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profile: state.profile }),
            });
            toast(
              aborted.ok ? "warn" : "error",
              aborted.ok ? `检测到隔离记录已失效，已自动恢复：${aborted.message}` : `隔离记录清理失败：${aborted.message}`,
            );
          } catch (error) {
            toast("error", `隔离记录清理失败：${error.message}`);
          }
        }
      }
    } catch {
      /* no run state */
    }
    // UI ↔ server linkage: if the server (terminal) exits, close this window too.
    let disconnectCount = 0;
    setInterval(async () => {
      const env = await refreshEnv();
      if (env === null) {
        disconnectCount += 1;
        if (disconnectCount >= 3) {
          showDisconnected();
          return;
        }
      } else {
        disconnectCount = 0;
      }
      if (state.launchActive || $("launch-status").hidden === false) pollLaunch();
      if ($("tab-snapshots").hidden === false) refreshSnapshots();
      // Monitor lifecycle: leave when the launch record is gone (DSH exited,
      // or the server auto-recovered a stale isolation elsewhere).
      if (state.monitor && !state.launchActive) {
        try {
          const rs = await api("/api/run-state");
          const record = rs.runState;
          if (!record) {
            leaveMonitor();
            toast("info", state.monitorIsolating ? "DSH 已退出，隔离前配置已自动恢复。" : "DSH 已退出，监控结束。");
          } else if (record.isolating && state.monitorIsolating) {
            const pids = state.env?.desktopPids ?? [];
            const alive = Number.isInteger(record.pid) && pids.includes(record.pid);
            if (!alive) {
              // The recorded isolated DSH vanished / DSH was launched directly:
              // force one-shot recovery from the UI side too.
              try {
                const aborted = await api("/api/abort-isolation", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ profile: state.profile }),
                });
                leaveMonitor();
                toast(
                  aborted.ok ? "warn" : "error",
                  aborted.ok ? `检测到 DSH 已退出或被外部启动：${aborted.message}` : `隔离清理失败：${aborted.message}`,
                );
              } catch {
                /* transient */
              }
            }
          }
        } catch {
          /* transient */
        }
      }
    }, 2000);
    setInterval(refreshActivity, 3000);
  })();
})();
