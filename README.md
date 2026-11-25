# dsh-plan-do · 边学边做

> 一句话：把一个小想法一步步学会并做出来的 DSH 模式——AI 只教、只验收，不代写。

装好之后，新建会话的预设列表里会出现「边学边做」。它把「记灵感 → 澄清 → 想法定稿 → 技术拆解 → 选路 → 边做边学 → 收尾」落成一条有硬约束的状态机：AI 看不到写文件的工具，只能教、只能验收，项目代码由你自己写。

## 当前状态

**v0.1.0 开发中（脚手架阶段）。** 本仓库当前只有包元数据、图标、双语描述与文档；`lib/`、`cordis.patch.yml` 尚未实现，因此**现在装上去还不能用**。进度与逐轮计划见 [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md)。

## 安装

三条装法，按场景选一条。

### ① npm（有版本号，可升级）

```bash
dsh plugin --profile <profile> add dsh-plan-do
```

### ② GitHub Release 的 tgz（不需要 npm 账号，国内网络更稳）

```bash
dsh plugin --profile <profile> add -w "https://github.com/<owner>/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"
```

### ③ 本地目录（开发期 / 首次验证，最稳）

在**有 `plugin_manager` 的会话**（创造模式 / `cordis` 预设）里执行：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

> 桌面版 profile 由 Electron 应用独占管理：`dsh --profile desktop --dump-default-config` 会直接报错，`dsh plugin --profile <name> …` 是 pnpm 透传，只完成「装依赖」这一半，**不一定**把包名写进 `dsh.profile.bundles`。所以桌面版请优先用 ③，或通过 dshmarket 安装。详见 [PLAN.md](PLAN.md) 第十节。

## 装完之后怎么用

1. 新建会话，在预设列表里选「边学边做」。
2. 直接把想法说给它，或者先让它把灵感记进灵感库（`~/.plando/ideas.json`，跨项目共享）。
3. 全程用 `plando_status` 看「现在到哪、下一步做什么、有没有卡住」；流程只能通过 `plando_transition` 往前推，非法推进会被拒绝并留痕。
4. 产物（`IDEA.md`、`TECH.md`、`HANDOFF.md`、`CHANGE-GUIDE.md`、任务卡）全部由插件从 `.plando/state.json` 渲染，不是 AI 手写的——所以「状态不会说谎」。

卸载（`plugin_manager action=remove_bundle`）后预设与工具消失，但 `~/.plando/` 与项目里的 `.plando/` **保留**：卸载不删用户数据。

## 能力说明（请先读这一节再评估安全性）

这个包在 DSH 市场索引里会被扫描出两项能力，**这是真的**：

- **`shell`**：`plando_check` 会执行命令，但**只执行用户在卡片里声明过的检查命令**（`.plando/checks.json`），不接受临时传入的任意命令。
- **`fs-write`**：`plando_scaffold` 会写文件，但**只写配置/脚手架白名单内的文件**（`package.json`、`tsconfig*.json`、`*.config.{js,ts,mjs,cjs}`、`.gitignore`、`.env.example`、`Dockerfile`、`docker-compose*.yml`、`requirements.txt`、`pyproject.toml`、`Makefile`、`.editorconfig`、`.github/workflows/*.yml`），且必须对应 TECH 清单里归属为「可交给 AI」的条目；此外插件要写 `.plando/` 状态与产物。

而**「AI 不代写」是模式内部的硬约束**，不是这个包没有写文件的能力：

1. 预设里不挂 `write` / `edit`（`dsh-tool-fs` 配 `write:false, edit:false`），也不挂 `bash` / `pwsh` / `terminal` / `run_code` / `subagent` / `workflow`——模型根本看不到这些工具。
2. 守卫（`ctx.tools.guard()`）兜底：非 build 阶段拒绝一切能改变世界的工具，理由里写明当前阶段和下一步；状态读不出来时写类工具 fail-closed。
3. `autoCommit` 默认 `false`：分发包不会在陌生人的仓库里默认写 git；即使显式打开，也只 `git add --` 模式产物清单，绝不 `git add -A`。

## 文档

| 文件 | 内容 |
|---|---|
| [PLAN.md](PLAN.md) | 方案、验收标准 A1–A9、分发形态 |
| [docs/START-HERE.md](docs/START-HERE.md) | 入口：这套文件怎么用 |
| [docs/CONTRACT.md](docs/CONTRACT.md) | `state.js` 契约：阶段 / 事件 / payload / 错误消息 |
| [docs/API-FACTS.md](docs/API-FACTS.md) | DSH 插件 API 的已验证事实（零依赖的由来） |
| [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md) | 逐轮开发任务卡与验收命令 |
| `docs/PROTOCOL.md` | 人读流程：阶段、出口判据、卡住协议（R7 待写） |
| `docs/INSTALL.md` | 安装与冒烟验证清单（R7 待写） |

## 开发

零依赖：`lib/` 下只允许 `import 'node:*'` 与同目录相对路径。测试用 `node:test`。

```bash
node --test                 # 跑测试
node scripts/verify-pack.mjs  # 断言 npm pack 清单完整（A8）
```

## 许可证

[MIT](LICENSE)
