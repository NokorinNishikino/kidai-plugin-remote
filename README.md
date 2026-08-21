<div align="center">

# 🛟 Kidai Plugin Remote · 纪代插件远程管理器

**DSH 坏了也能用的插件管理器** —— 查看 · 启停 · 启动 · 隔离运行 · 快照 · 回滚

**简体中文** · [**English**](README.en.md)

</div>

---

## ✨ 为什么用？

DeepSeek Harness（DSH）的插件生态越来越丰富，但**启动失败往往来自插件本身**：
损坏的 bundle 列表、缺失的依赖、自引用 `file:./node_modules/...` 依赖……一旦 DSH
起不来，DSH 自己也救不了自己。**Kidai Plugin Remote** 就是为这种时刻准备的
外部救援与日常管理工具——它在 DSH 之外运行，DSH 挂掉也能用。

- 🛟 **先救援** —— 启动失败给出「退出码 + 日志 + 崩溃转储 + 冲突分析 + 修复提示」；
  一键回滚到最近良好快照，或**隔离运行**纯原生基线进行分析
- 📋 **与纪代市场同源** —— 插件列表用与市场完全相同的方式组合
  （bundle 层 → profile 补丁 → home 补丁 → 桌面壳层），所见即 DSH 所载
- 🧊 **隔离仅一次有效** —— 本次运行禁用全部第三方插件；退出自动恢复原配置，
  即使管理器被杀，内部守护也会在下次启动时恢复
- 💾 **快照与回滚** —— 每次启动 / 配置变更保留一版待确认快照，下次成功运行转为
  「已验证」；离线回滚配置 + 第三方插件目录
- 🧩 **插件管理** —— 孤儿扫描 / 装载 / 残留清理 / 卸载 + 入口校验（对齐市场 Hub 1.3.4）
- 🎨 **8 套主题** —— 暗色 / 浅色 / DS 蓝 / 灰绿 / 紫罗兰 / 青 / 珊瑚 / 玫瑰，服务器端记忆
- 🧲 **四种启动方式** —— 正常 / 隔离 / 预检分析 / 失败报告；成功自动最小化

> **无需理解任何技术细节** —— 打开即用；开发者也能享受完整的组合诊断。

---

## 🚀 快速开始

**方式 A — 零依赖桌面客户端（推荐分发）**

使用配套仓库 [**kidai-plugin-remote-client**](https://github.com/NokorinNishikino/kidai-plugin-remote-client)
的 `Kidai Plugin Remote Client.exe`：下载解压、双击即用。**不需要 Node、不需要浏览器。**

**方式 B — 经典启动**

```
install.cmd                        # 一键安装：检查 Node、装入内部守护、创建桌面快捷方式
启动 Kidai Plugin Remote.cmd       # 直接启动（浏览器独立窗口）
```

源码直接跑：

```bash
node server.js                     # 打开管理器 http://127.0.0.1:4877
node scripts/self-check.mjs        # 只读自检（不启动 DSH、不改配置）
```

环境要求：本机 **Node.js ≥ 20**（不需要 DSH 本体）。

---

## 🔗 生态

| 仓库 | 职责 | 运行位置 |
|---|---|---|
| **kidai-plugin-remote**（你在这里） | 查看 / 启停 / 启动 / 隔离 / 回滚 | DSH 之外（独立程序） |
| [**kidai-plugin-remote-client**](https://github.com/NokorinNishikino/kidai-plugin-remote-client) | 同一管理器，原生窗口，零依赖 | DSH 之外（独立程序） |
| [**kidai-snapshot-guard**](https://github.com/NokorinNishikino/kidai-snapshot-guard) | 快照、待确认→已验证、隔离自动恢复 | DSH 内部（插件） |

三者共享同一个快照存储（`$DSH_HOME/.kidai-snapshots`）与守护目录
（`$DSH_HOME/guard/`）——在任意一端给快照加备注，另一端都能看到。

---

## 📸 技术细节

- **读取** — `$DSH_HOME` → profile manifest `dsh.profile.bundles` → 双锚点解析
  （先 DSH 安装、后 profile）→ 按启动顺序应用补丁层（include 插件的精确算法，
  `!!js` 只解析不评估）→ 真实 loader 条目树。
- **写入** — 启停只写 home 级 `cordis.patch.yml`（与市场完全一致）；隔离额外写
  桌面私有 `plugin-management/state.json`，退出或下次启动时自动还原。
- **启动** — spawn `DSH Desktop.exe`（自动发现或 `DSH_DESKTOP_DIR`）；成功判定用
  桌面端自己的 health-commit；失败证据来自退出码、`%APPDATA%\DSH Desktop\logs`、
  `crash-evidence`、`profile-selection`、`plugin-install-recovery`。
- **CLI 校验** — `dsh --dump-config` 需要 Node ≥ 22；系统 Node 过旧时自动改用
  桌面自带运行时（`ELECTRON_RUN_AS_NODE=1`，零下载）。
- **韧性** — 任何单个损坏的 bundle（manifest 损坏、目录缺失、补丁损坏）都会被
  **跳过并报告，绝不致命**：管理器、客户端、界面都能继续工作。

```
kidai-plugin-remote/
├── server.js                # HTTP + API（127.0.0.1:4877）
├── lib/                     # dsh-env · patches · profile · inventory · conflicts · plugin-mgmt · snapshots · launcher
├── public/                  # 单页 UI（无构建步骤）+ 8 套主题
├── vendor/yaml/             # 内置 yaml 2.9.0（完全离线）
├── scripts/                 # self-check · test-* · install-guard · install-shortcut · build-exe
├── install.cmd              # 一键安装
├── 启动 Kidai Plugin Remote.cmd
└── build/                   # exe 构建产物
```

## 📄 License

MIT
