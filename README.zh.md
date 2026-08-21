# Kidai Plugin Remote · 纪代插件远程管理器

脱离 DSH 与 DSH Desktop 的**外部**插件管理器：不需要 DSH 正在运行，也不需要 DSH 的运行时（仅需本机 Node.js ≥ 20）。

它的诞生背景：纪代市场（kidai-plugin-market）开发迭代中，重启验证时多次出现「关掉进程后就再也打不开 DSH」——损坏的 bundle 列表、缺失的依赖、自引用 `file:./node_modules/...` 依赖等都会让 DSH 启动即失败，而 DSH 自己已经起不来了。Kidai Plugin Remote 就是为这种时刻准备的「外部救援与日常管理」工具。

## 它能做什么

| 功能 | 说明 |
|---|---|
| 已安装插件列表 | **与纪代市场完全相同的方式**读取：profile manifest 的 `dsh.profile.bundles` + 每个 bundle 的 `cordis.patch.yml` + profile/home 两级 patch 层，逐层组合出真实的 loader 条目树（含 desktop 壳层 overlay），再标注 原生/第三方、启用/停用、版本、路径、安装时间 |
| 排序 / 筛选 / 视图 | 按名称、状态、安装时间排序；按类型（第三方/原生）、状态（启用/停用）、关键词筛选；宽/窄横条视图；强制刷新 |
| 启用 / 停用 | 与市场 `setEnabled` 同一套写入：合并 `{id, disabled}` 到 `$DSH_HOME/cordis.patch.yml`，先自动备份（`.kidai-remote-backups`），重启 DSH 后生效；DSH 运行中时 HMR 也会实时应用 |
| **孤儿插件管理**（对齐 Hub 1.3.4） | 「未运行的插件文件」区：文件存在但未挂载的插件（手动安装 / 桌面插件管理停用 / 卸载残留）自动列出并给出原因；已声明依赖的可**「启用」**重新挂载（加入 `dsh.profile.bundles` + 清除 home patch 禁用行 + **清除桌面 `plugin-management` 停用状态**），未声明的可**「删除文件」**清理（node_modules 目录 + vendor 副本 + `@local` junction，悬空安全）；已声明依赖的删除会自动转正式卸载 |
| **卸载插件**（对齐 Hub 1.3.4） | `pnpm remove` + bundles 清单收敛 + home patch 行按 loader 条目 id 清理 + `@local`/扁平回退 junction 清理（含 `@local/*` 名称归一化与悬空 junction），先快照备份、失败自动回滚；拒绝卸载核心插件 |
| **入口校验硬化**（对齐 Hub 1.3.4） | 声明 `dsh.bundle` 但没有可加载入口（无 main/exports、无 index.js）的包：挂载时**拒绝**（misakanet 故障模式）、列表中打「⚠ 无入口文件」徽标、预检中列为高危并给出修法 |
| 启动 DSH Desktop | 按当前选择启动；启动前自动做组合预检，有高危问题会先给出报告 |
| **隔离运行** | 本次运行停用**全部**第三方插件：同时写入 desktop 私有的 `plugin-management/state.json`（整包跳过，连损坏的包都能跳过）和 home patch（条目级停用），启动原生 DSH；DSH 退出后**自动恢复**原配置，也可手动「结束隔离」 |
| 启动成功 → 自动最小化 | 监控到 DSH 的 health-commit（profile-selection 状态 active == lastKnownGood == 当前 profile）即判定成功，管理器控制台自动最小化、页面折叠为后台监控条，继续监控 |
| 启动失败 → 报错报告 | 给出：退出码、stderr、桌面日志错误线索、崩溃转储、profile-selection 回退状态、以及**冲突分析 + 修复提示**（未解析的 bundle、缺 `dsh.bundle` 声明、patch 文件损坏、重复条目 id、patch 未命中、自引用依赖、安装事务残留等，每条附具体修法） |
| **快照与回滚** | 每次「配置变更（启停/装载/卸载/删除）」与「启动 DSH」前，自动在 `$DSH_HOME/.kidai-snapshots/` 保留一版**待确认快照**（profile manifest + 两级 patch + 桌面启停状态 + **第三方插件目录副本**，完全离线可回滚）；**直到下次成功运行**才转为「已验证」——由内部守护插件（kidai-snapshot-guard）或 KPR 的启动健康检查确认；启动失败则标为失败。KPR 的「快照与回滚」页可一键**回滚**（先对当前状态再拍一版，回滚自身可逆），恢复配置与插件目录后重启 DSH 即回到更新前 |
| **内部守护插件** | `kidai-snapshot-guard`（已装入 desktop profile）：随 DSH 启动，每次成功启动把待确认快照标记为已验证；提供只读 `/kidai-snapshot` 命令；与 KPR 共享同一快照存储（KPMH 也可读取） |
| 预检分析 | `dsh --profile <p> --dump-config`（boot-free，可随时跑）+ 本地组合校验，双重确认 |
| 无联网市场 | 完全没有获取在线插件目录的部分 |

## 桌面端界面

三个页签：

- **已安装插件**：插件列表（宽/窄条）+ 孤儿插件区 + 右侧启动控制（启动 / 隔离运行 / 预检）。
- **快照与回滚**：快照列表（状态徽标：待确认/已验证/启动失败/已回滚；触发方式：启动前/启停变更/配置变更/回滚前；包数量与体积），一键回滚（二次确认）。
- **设置**：自动快照开关（启动前 / 配置变更前）、保留快照数上限、环境信息、内部守护插件状态、打开插件/快照目录。

## 快速开始

三种启动方式任选：

1. **双击 `启动 Kidai Plugin Remote.cmd`**（推荐日常使用）
   - 自动打开独立窗口（Edge/Chrome 应用模式）指向 `http://127.0.0.1:4877`
   - 关闭控制台窗口即停止管理器（DSH 本身不受影响）
2. **封包 exe**：先构建一次 `scripts\build-exe.ps1`（零下载，用系统自带 .NET csc.exe），得到 `build\Kidai Plugin Remote.exe`——单个文件，双击即用，首次运行自解压到 `%LOCALAPPDATA%\KidaiPluginRemote\app`
3. **独立 Client（零依赖，推荐分发）**：`kidai-plugin-remote-client` 工程打包出 `dist\Kidai Plugin Remote Client.exe`——自带 Electron 运行时，**不需要 Node、不需要浏览器**，双击即打开原生窗口；构建见该工程 `build-client.ps1`（需先下载 Electron 发行版到 `vendor\`）
4. **直接跑源码**：`node server.js`（环境变量：`KPR_PORT` 端口、`KPR_NO_OPEN=1` 不自动开浏览器、`KPR_DATA` 数据目录、`KPR_NODE` 指定新版 node）

自检（只读，不启动 DSH、不改配置）：

```
node scripts/self-check.mjs
```

## 版本与分发（GitHub）

当前版本 **1.2.6**。仓库结构：

```
kidai-plugin-remote/     # 管理器本体（node server + web UI + 构建脚本）
kidai-plugin-remote-client/  # 独立 Electron 客户端（安装即用，零依赖）
kidai-snapshot-guard/    # DSH 内部守护插件（快照的 DSH 内半边，随 DSH 启动）
```

**像插件一样安装即用的分发方式**：

- **最省事**：把 `kidai-plugin-remote-client\dist\` 打包 zip 传到 GitHub Releases——用户下载解压、双击 `Kidai Plugin Remote Client.exe` 即用（自带 Electron，无需任何运行时）。
- **经典版**：`build\Kidai Plugin Remote.exe` 单文件（需系统 Node ≥ 20 才能启动 DSH 的 CLI 校验；纯启停/快照功能可用）。
- **源码安装**：`git clone` → 有 Node 的环境直接 `node server.js`。
- 管理器与内部守护（KSG）通过 `$DSH_HOME\.kidai-snapshots` 与 `$DSH_HOME\guard\` 自动对接，两端版本独立、无需配对安装。

## 运行机制（与 DSH 的关系）

- **读**：`$DSH_HOME`（`DSH_HOME` 或 `~/.dsh`）→ `profiles/<name>/package.json` 的 bundles → 双锚点解析包目录（先 DSH 安装、后 profile）→ 按「bundle 层 → profile 层 → home 层 → overlay」顺序用 include 插件的 patch 算法组合（`!!js` 表达式只解析展示、不评估），结果与 DSH 实际启动的树一致。
- **写**：启停只写 home 级 `cordis.patch.yml`（与市场完全一致）；隔离运行额外写 desktop 的 `plugin-management/state.json`（该机制能跳过损坏 bundle——桌面端自己的恢复路径），退出即还原。
- **启动**：spawn `DSH Desktop.exe`（自动发现安装目录，或设 `DSH_DESKTOP_DIR`）；成功判定用桌面端自己的 health-commit 信号；失败证据来自退出码、`%APPDATA%\DSH Desktop\logs`、`crash-evidence`、`profile-selection` 状态与 `plugin-install-recovery`。
- **CLI 校验**：`dsh --dump-config` 需要 Node ≥ 22。系统 Node 不足时自动改用 **Electron-as-Node**（`ELECTRON_RUN_AS_NODE=1` 复用 DSH Desktop 自带运行时，零下载）；都不行则该按钮提示不可用，本地组合校验仍可用。

## 目录结构

```
kidai-plugin-remote/
├── server.js                # HTTP 服务 + API（127.0.0.1:4877）
├── lib/
│   ├── dsh-env.js           # 发现 DSH_HOME / 安装 / 用户数据 / 运行状态
│   ├── patches.js           # patch 解析（含 !!js）、include 合并算法、备份/写回
│   ├── profile.js           # 复刻 loadProfile/composeEntries/desktop overlay
│   ├── inventory.js         # 已安装插件行（同市场的 thirdPartyPlugins）+ 入口校验
│   ├── conflicts.js         # 启动前冲突分析与修复提示（含入口校验发现）
│   ├── plugin-mgmt.js       # 孤儿扫描/装载/删除残留/卸载（对齐 Hub 1.3.4）
│   ├── snapshots.js         # 共享快照存储（pending→verified→rolled-back）+ 回滚
│   └── launcher.js          # 启动/隔离/监控/恢复/CLI dump
├── public/                  # 网页 UI（三个页签：已安装 / 快照与回滚 / 设置）
├── vendor/yaml/             # 内置 yaml 2.9.0（完全离线）
├── scripts/
│   ├── self-check.mjs       # 只读自检
│   ├── test-snapshots.mjs   # 快照/回滚生命周期测试（临时 profile）
│   ├── install-guard.ps1    # 安装内部守护插件到 profile
│   ├── build-exe.ps1        # 单文件 exe 封包
│   └── minimize-console.ps1 # 启动成功后控制台最小化
├── 启动 Kidai Plugin Remote.cmd
└── build/                   # 构建产物（exe）

兄弟包：`../kidai-snapshot-guard`（内部守护插件，快照的 DSH 内半边）。
```

## 常见修复提示（预检报告会给出）

- 未解析的 bundle → `dsh plugin --profile desktop add <包名>`，或先在管理器里「隔离运行」
- 包缺 `dsh.bundle` 声明 → 修 package.json 或移除该 bundle
- patch 文件损坏/不是顶层数组 → 修复该文件（管理器有备份）
- 重复条目 id / patch 未命中 → 检查各 bundle 的 insert 与 id
- 自引用 `file:./node_modules/...` 依赖 → 改成正规版本号（这是历史故障元凶之一）
- DSH 起不来但又有必用数据 → 「隔离运行」先用原生基线启动，再逐个恢复插件

## 许可证

MIT
