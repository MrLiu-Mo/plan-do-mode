# dsh-plan-do · 边学边做

> 一句话：把一个小想法一步步学会并做出来的 DSH 模式——AI 只教、只验收，不代写。

装好之后，新建会话的预设列表里会出现「边学边做」。它把「记灵感 → 澄清 → 想法定稿 → 技术拆解 → 选路 → 边做边学 → 收尾」落成一条有硬约束的状态机：AI 看不到写文件的工具，只能教、只能验收，项目代码由你自己写。

## 当前状态

**v0.1.0 已完成，验收 A1–A9 全部通过（A9 于 2026-11-26 真装一次验过）。** `cordis.patch.yml`（预设 + 人格提示词）、`lib/` 下 12 个模块（状态机 / 产物 / 项目 / 卡片 / 检查 / 脚手架 / 守卫 / 8 个工具 / 入口）与 417 条测试均已就位；流程说明看 [docs/PROTOCOL.md](docs/PROTOCOL.md)，装/卸与冒烟看 [docs/INSTALL.md](docs/INSTALL.md)，第一次上手看 [docs/START-HERE.md](docs/START-HERE.md)。进度与逐轮计划见 [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md)。

> A9 第一次真装时抓到过一个真 bug：`lib/index.js` 里的 `export default apply` 让
> `cordis-plugin-loader` 丢掉命名 `inject`，插件显示「加载失败」。修法与「为什么四条验证都没拦住」
> 记在 `docs/REVIEW-tools.md` §18（该文件不进分发包，所以这里不链接）。

## 安装

**装插件需要「创造模式」（或任何带 `plugin_manager` 的会话）；写代码、跑测试都不需要。** 这两件事的会话是分开的，详见 [docs/START-HERE.md](docs/START-HERE.md) 第三节。

### ① 本地目录（开发期 / 首次验证，最稳，推荐先走这条）

在**有 `plugin_manager` 的会话**里执行：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
plugin_manager action=list_plugins        # 确认 preset-plan-do 在，状态不是 failed
```

装完：**新建会话 → 预设列表里多出「边学边做」**，选它即可。

### ② GitHub Release 的 tgz（发布后给别人，不需要 npm 账号）

**已经发布**：[Releases → v0.1.0](https://github.com/MrLiu-Mo/plan-do-mode/releases/tag/v0.1.0)

```bash
# 下载后用本地文件装（--profile 是必填的，CLI 会报 required option）
dsh plugin --profile <profile> add ./dsh-plan-do-0.1.0.tgz

# 或者直接给 URL
dsh plugin --profile <profile> add -w "https://github.com/MrLiu-Mo/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"
```

> **前提：仓库得是 public。** 私有仓库上这条下载 URL 对未登录的人返回 **404**（不是 401），
> 别人只会看到一句「找不到」。发布给外部使用前先把仓库转成 public。
> 校验和：`c0f692897d51c931f590240405ea434a93153d8c974179317368a6f86265bc9e`（146 kB）。

实测（2026-11-25，本机 pnpm 11）：`dsh plugin --profile <name> add <tgz>` 会把 `dsh-plan-do` 同时写进 `dependencies` 和 `dsh.profile.bundles`；`remove dsh-plan-do` 会两处一起清掉。装完同样是**新建会话 → 预设列表 → 「边学边做」**。

### ③ npm（有版本号，可升级）

```bash
dsh plugin --profile <profile> add dsh-plan-do
```

装完同上：预设列表里的「边学边做」。

> **关于 CLI 的实测提醒（2026-11-25 本机验证）**：
> - `dsh plugin` 的 `--profile` 是**必填**，省略会直接报 `required option '--profile <name>' not specified`；它把其余参数**原样透传**给 pnpm（`add` / `remove` / `install` 都能用），所以它只完成「装依赖 + 写 bundles」这一半，插件是否真的被加载仍要在 `plugin_manager list_plugins` 里确认。
> - **桌面 profile 由 Electron 应用独占管理**（`dsh --profile desktop --dump-default-config` 会报 `managed exclusively by the Electron application`）；`dsh plugin --profile desktop …` 即使能装依赖，也不保证桌面应用认这份 bundles。桌面版请走 ① 或 dshmarket。

### 卸载

在创造模式会话里：

```text
plugin_manager action=remove_bundle
```

非桌面托管的 profile 也可以 `dsh plugin --profile <profile> remove dsh-plan-do`。

卸载后「边学边做」预设与 8 个工具消失，但 `~/.plando/`（灵感库、项目索引）与各项目里的 `.plando/` **保留**——卸载不删用户数据。

## 装完之后怎么用

1. 新建会话，在预设列表里选「边学边做」。
2. 直接把想法说给它，或者先让它把灵感记进灵感库（`~/.plando/ideas.json`，跨项目共享）。
3. 全程用 `plando_status` 看「现在到哪、下一步做什么、有没有卡住」；流程只能通过 `plando_transition` 往前推，非法推进会被拒绝并留痕。
4. 产物（`IDEA.md`、`TECH.md`、`HANDOFF.md`、`CHANGE-GUIDE.md`、任务卡）全部由插件从 `.plando/state.json` 渲染，不是 AI 手写的——所以「状态不会说谎」。

## 这个模式怎么工作

预设「边学边做」= 8 个 `plando_*` 工具 + 只读文件工具（`read` / `glob` / `grep`）+ 一段人格提示词。模型**看不到** `write` / `edit` / `bash` / `pwsh` / `subagent`。

**11 个阶段**（`plando_status` 会说清现在在哪、下一步做什么）：

| 阶段 | 该做什么 |
|---|---|
| `inbox` | 灵感已记，还没立项（项目不会停在这里） |
| `clarify` | 澄清：做成了是什么样、不做什么、谁用、有哪些假设 |
| `idea` | 想法定稿，渲染 `IDEA.md` |
| `tech` | 技术拆解，渲染 `TECH.md`；超出预算就拒绝 |
| `decide` | 选路：小验证 / 直接做 / 交给 AI 做、人只验收 |
| `verify` | 时间盒小验证，只验一个假设，必须带证据 |
| `build` | 边做边学，逐卡「学 → 做 → 验」 |
| `ship` | 收尾验收：离线能跑，能讲清自己改了什么 |
| `done` / `handoff` / `dropped` | 三个终态：成了 / 交给 AI / 放弃或搁置 |

**8 个工具**：`plando_status` 看阶段与下一步；`plando_project` open/list/init 项目；`plando_idea` 灵感库 add/list/pick/park/drop；`plando_clarify` 记录澄清答案（≤2 轮）；`plando_transition` 唯一推进入口；`plando_card` 卡片 start/done/downgrade/evidence；`plando_check` 只跑 `.plando/checks.json` 里已声明的命令；`plando_scaffold` 只写白名单配置文件。

**两道守卫拦「代写」**：

1. **结构性**：上面那个预设本身不挂任何写工具，`dsh-tool-fs` 显式 `write: false, edit: false`——模型连工具都没有。
2. **运行时**：`ctx.tools.guard()` 在非 `build` 阶段拒绝一切能改变世界的工具，拒绝理由里写明当前阶段和下一步；状态读不出来时写类工具 fail-closed，只读工具放行，`plando_*` 自带阶段校验不拦。名单按能力列在 `lib/policy.js`（文件写 / 命令执行 / 动态代码 / 委派），可用 `guardExtraDeny` 追加。

**插件配置**（写进 `cordis.patch.yml` 的 `plan-do-mode.config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `~/.plando` | 灵感库与项目索引的根目录，留空用默认值 |
| `autoCommit` | `false` | 打开后只提交模式产物（绝不 `git add -A`） |
| `budget` | `{ mustUnderstand: 5, totalMinutes: 600 }` | `归属=user` 的条目数与总时长上限 |
| `sizeThresholdMinutes` | `300` | 总预计分钟超过它就判「大项目」，此时 `decide` 会推荐先做时间盒小验证；立项时快照进 `state.tech.threshold`，改配置不影响已有项目 |
| `guardExtraDeny` | `[]` | 额外要拦的工具名（前缀匹配带后缀的变体） |

## 能力说明（请先读这一节再评估安全性）

这个包在 DSH 市场索引里会被扫描出两项能力，**这是真的**：

- **`shell`**：`plando_check` 会执行命令，但**只执行用户在卡片里声明过的检查命令**（`.plando/checks.json`），不接受临时传入的任意命令；而且要过五道闸：可执行文件白名单、内联执行开关拦截（`node -e`、`python -c`、`npm install`、`cargo run`、`java -jar` 这类一律拒）、**写文件类开关整类拒**（`--test-reporter-destination`、`--redirect-warnings`、`--cpu-prof-dir` 这些等于任意文件写）、**路径类参数不许指向项目外**（`--prefix` / `--cache` / `--outDir` / `../x.js` 这类）、**`npx` 不是洗白前缀**（剥掉 `npx` 后按同一条命令重判，`npx node -e` 与 `node -e` 一样拒）。
- **`fs-write`**：`plando_scaffold` 会写文件，但**只写白名单内的 7 个声明式配置文件**（`package.json`、`tsconfig.json`、`.gitignore`、`.env.example`、`pyproject.toml`、`requirements.txt`、`Cargo.toml`），内容也要过校验（`scripts` 只认 `test` / `build` / `lint` 这类键且**值要过命令校验**：`;` / `|` / 反引号 / `$(` 整条拒，`&&` 分档每段单独查，环境变量前缀拒，命令名必须与 `plando_check` 用同一份白名单；`postinstall` 之类生命周期钩子与 `http:` / `git:` / `file:` 形式的依赖同样拒），且必须对应 TECH 清单里归属为「可交给 AI」的条目；此外插件要写 `.plando/` 状态与产物。

而**「AI 不代写」是模式内部的硬约束**，不是这个包没有写文件的能力：

1. 预设里不挂 `write` / `edit`（`dsh-tool-fs` 配 `write:false, edit:false`），也不挂 `bash` / `pwsh` / `terminal` / `run_code` / `subagent` / `workflow`——模型根本看不到这些工具。
2. 守卫（`ctx.tools.guard()`）兜底：非 build 阶段拒绝一切能改变世界的工具，理由里写明当前阶段和下一步；状态读不出来时写类工具 fail-closed。
3. `autoCommit` 默认 `false`：分发包不会在陌生人的仓库里默认写 git；即使显式打开，也只 `git add --` 模式产物清单，绝不 `git add -A`。

### 已知残余（0.1.0 不修，明说而不是假装拦住了）

内部审计（`docs/REVIEW-tools.md`，不进分发包）对着命令白名单做过五轮对抗测试，下面这些是**放行了但目前打不通副作用**的，或者「拦不住、但不构成实际风险」的：

- **`node evil.js` 及串联写法放行**（`npm test && node evil.js` 也是）。要构成攻击，那个 `.js` 得先在项目里——本插件写不出 `.js`（`plando_scaffold` 只写 7 个声明式配置文件，且 `.js` 直接拒）。换句话说，这要求**项目里本来就有**那个文件，或者用户自己写进去。
- **`deno run x.ts` / `bun run x.ts` 放行**。这两个解释器的核心用法就是执行一个文件，argv 上无法与「跑检查」区分；白名单里保留它们是因为 `deno test` / `bun test` 常用。
- **`--watch` / `--inspect-brk` 会挂满 60 秒超时**，超时后按失败处理（不会放行）。裸写 `npx <工具>`（如 `npx vitest`）也属于这一类——它可能进交互式 watch，同样只会超时失败。
- 另有若干「白名单内工具 + 无意义/不存在开关」的组合会放行，到工具那一步自己报错，不产生副作用。

`plando_check` 的执行结果会写 `.plando/last-check.json`，`plando_card done` 拿它和证据对账；文件类证据要和项目里真实存在的文件对账。**而且项目里必须至少有一个你自己写出来的文件**——模式产物（`IDEA.md` 等）与插件能写的配置文件（`package.json` 等）不算，因为那两类都可能是插件/AI 自己造的。所以「自称跑过了」和「拿配置文件凑数」都不算证据。

## 文档

| 文件 | 内容 |
|---|---|
| [PLAN.md](PLAN.md) | 方案、验收标准 A1–A9、分发形态 |
| [docs/START-HERE.md](docs/START-HERE.md) | 入口：这套文件怎么用 |
| [docs/CONTRACT.md](docs/CONTRACT.md) | `state.js` 契约：阶段 / 事件 / payload / 错误消息 |
| [docs/API-FACTS.md](docs/API-FACTS.md) | DSH 插件 API 的已验证事实（零依赖的由来） |
| [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md) | 逐轮开发任务卡与验收命令 |
| `docs/PROTOCOL.md` | 人读流程：11 阶段出口判据、三问、卡住时的三档升级 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安装、冒烟验证清单、卸载 |
| [docs/RELEASE.md](docs/RELEASE.md) | 发布流程（给发布者看：填元数据 → 四条验证 → npm / Release → 真装一次） |

## 开发

零依赖：`lib/` 下只允许 `import 'node:*'` 与同目录相对路径。测试用 `node:test`。CI 在 ubuntu + windows 两个平台跑同样四条命令（[.github/workflows/test.yml](.github/workflows/test.yml)）。

```bash
node --test                    # 全量测试
node scripts/check-docs.mjs    # 文档互相引用一致
node scripts/verify-pack.mjs   # 真跑 npm pack，断言 files 白名单没漏文件（A8）
node scripts/smoke-pack.mjs    # 真打包、真解开、真加载，跑一遍 init→clarify→idea（A9 可自动化那半）
```

发布前额外跑一条（不进 CI，因为它检查工作区是否干净）：

```bash
node scripts/release-check.mjs # 元数据填全、文档里没有占位符、工作区无未提交改动
```

发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。

## 许可证

[MIT](LICENSE)
