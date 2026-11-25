# plan-do 模式：把一个小想法「学会并做出来」的 DSH 模式

## 一、目标与验收标准

**目标**：在 `A:\AI\plan-do-mode` 做一个独立的 DSH 模式（agent preset + Host 插件 + 守卫），把用户的 8 步流程落成有硬约束的状态机，并修正上一轮指出的缺口。核心承诺三条：

1. **AI 不代写**：结构性保证——预设里 `write`/`edit` 根本不注册（`dsh-tool-fs` 配 `write:false, edit:false`），另加守卫兜底。
2. **产物是用户的**：IDEA.md / TECH.md / 任务卡 / 交接文档全部由插件从 `state.json` 渲染（不是 AI 手写文档），保证「状态不能说谎」；每张卡都有可运行的检查点。
3. **流程不会自己往前跑**：唯一推进入口是 `plando_transition`，非法转移被拒绝并留痕。

**验收标准（全部满足才算完成）**：

| # | 标准 | 怎么验 |
|---|---|---|
| A1 | `node --test` 全绿，零依赖 | 本地跑；`test/plugin.test.js` 用裸 node 导入 + 静态禁止裸包名 |
| A2 | 预设能装上且激活 | `plugin_manager list_plugins` 出现 `preset-plan-do`，状态非 `failed` |
| A3 | 新会话预设列表出现「边学边做」 | 新建会话时目视确认 |
| A4 | 守卫真的拦得住 | 冒烟会话里让 AI 写项目代码 → 报错；`write` 工具在工具列表里不存在 |
| A5 | 全链路跑得通 | 冒烟工作区走完：灵感→澄清→IDEA→TECH→选路→卡→收尾，产物文件齐全 |
| A6 | 产物可追踪 | 每次推进在项目仓库里产生一次只含模式产物的 commit |
| A7 | glim 不受影响 | `A:\AI\glim` 无任何改动 |
| A8 | 分发包完整 | `npm pack --dry-run --json` 的清单覆盖 `lib/` 全部模块 + `cordis.patch.yml` + 两个 locale + `icon.svg`；缺一个即失败 |
| A9 | 装得上、卸得干净 | `plugin_manager action=install_bundle` 后「边学边做」可选中；卸载后 preset 消失，`~/.plando` 与项目 `.plando/` 保留 |

---

## 二、交付物结构

```
A:\AI\plan-do-mode\
├─ package.json            # dsh-plan-do，dsh.bundle.patch + files/exports 白名单
├─ cordis.patch.yml        # 插入 preset-plan-do（persona 提示词 + 插件清单）
├─ icon.svg                # 原创图标
├─ locale/en.json zh.json  # meta.title / meta.description（双语，市场索引要用）
├─ LICENSE                 # MIT
├─ scripts/verify-pack.mjs # 断言 npm pack 清单完整（零依赖）
├─ scripts/check-docs.mjs  # 断言三份文档互相引用一致（阶段/事件/工具/§ 编号/链接）
├─ .github/workflows/test.yml # CI：node --test + verify-pack
├─ lib/
│  ├─ index.js             # apply(ctx, config)：注册 8 个工具 + 守卫
│  ├─ config.js            # 零依赖配置校验（dataRoot / budget / defaultProjectDir）
│  ├─ state.js             # 状态机：阶段、事件、合法性、payload 校验
│  ├─ project.js           # 项目定位/加载/保存 + dataRoot 灵感库索引
│  ├─ artifacts.js         # 从 state 渲染全部产物
│  ├─ cards.js             # 任务卡生命周期与 TECH 覆盖校验
│  ├─ checks.js            # 执行「已声明」的检查命令
│  ├─ scaffold.js          # 配置/脚手架白名单写入
│  ├─ git.js               # 只提交模式产物
│  ├─ policy.js            # 守卫规则（纯函数）
│  ├─ tools.js             # 工具定义（手工拼 ToolDefinition，不用 defineTool）
│  └─ format.js            # plando_status 的文本渲染
├─ docs/PROTOCOL.md        # 人读流程：阶段/出口/判据/卡住协议
├─ docs/INSTALL.md         # 安装 + 冒烟验证清单
├─ docs/START-HERE.md      # 入口：这套文件怎么用、创造模式什么时候需要
├─ docs/CONTRACT.md        # state.js 契约：阶段/事件/payload/错误消息（实现者必读）
├─ docs/API-FACTS.md       # DSH 插件 API 已验证事实（从 glim-mode 摘，防幻觉）
├─ docs/DEV-PROMPTS.md     # 交给别的 AI 实现的逐轮提示词（R0–R7 + 验收卡 + 纠偏卡）
├─ test/*.test.js          # 测试文件，按 R0–R7 逐轮累加（每轮新增的模块都带测试）
└─ README.md
```

**实施方式**：按 [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md) 的 R0–R7 逐轮推进，每轮一 commit；
实现细节以 [docs/CONTRACT.md](docs/CONTRACT.md) 为准，DSH API 用法以 [docs/API-FACTS.md](docs/API-FACTS.md) 为准。

**硬约束：零依赖。** 只 import `node:` 内置模块和本目录文件。因此工具用裸 `ToolDefinition` 对象（`parameters` 用原始 JSON Schema，`output: { schema:{type:'string'}, render }`），配置手工校验。

理由（**已修正**，见第十节）：`link:` 安装解析不到裸包名，只对开发期的 `install_bundle` 成立；npm / GitHub / tgz 安装会把包真实装进 profile 的 `node_modules`，`@deepseek-ai/*` 是能解析的（`dsh-prompt-rewriter` 就把 `@deepseek-ai/schemastery` 写成真实 dependency）。零依赖仍然保留，理由是「四种安装形态都起得来 + 不锁 DSH 内部包版本 + 守卫可审计」，不是「不分发就没法用」。代价：插件页没有配置表单，配置只能写在 `cordis.patch.yml` 里。

---

## 三、状态机（数据模型）

### 阶段

```
inbox ──pick──▶ clarify ──clarify_done──▶ idea ──idea_ok──▶ tech ──tech_ok──▶ decide
decide ──choose_verify──▶ verify ──verify_result──▶ decide
decide ──choose_build──▶ build ──cards_done──▶ ship ──ship_pass──▶ done
decide ──choose_handoff──▶ handoff（终态）
任意非终态 ──drop(reason: falsified|parked)──▶ dropped（终态）
idea/tech/decide/build ──revise──▶ tech（作废受影响卡）
任意非终态 ──pause/resume──▶ 同阶段（paused 标志，不做成第九阶段）
终态 ──reopen(reason)──▶ decide
```

### 关键规则（对应上一轮缺口）

- **「完成」有定义**：`clarify_done` 必须带 `what / done / notDo` 三句 + 基线三项；`done` 是用户可观察现象，不是「功能都实现了」。
- **基线前置**：`baseline = {experience, hoursPerWeek, goal: 'learn'|'ship'}`，决定 TECH 难度判定与预算。
- **方法 1/2 合并**：不设「选方法」分支；每张卡固定 `学 → 做 → 验` 三段。
- **规模与推荐**：`tech_ok` 时算 `size`：`totalMinutes > 180` 或 `promiseRisk=true` → `large`。`large` 时 `decide` 的推荐必须是 `verify`，且 `verify_result` 后**必须回 decide 重选**，不能直接进 build。
- **验证有时间盒与三出口**：`verify` 的 `timeboxMin ≤ 60`；结果 `pass|fail|inconclusive` 都回 decide，并各自给出默认建议。
- **想法变更**：`revise` 需要 `reason`，重渲染 IDEA.md、把受影响卡标 `stale`、退回 tech。
- **中断恢复**：`plando_project open` 读回 `<项目>/.plando/state.json`，`plando_status` 给出「上次到哪/下一步/未解问题/卡在哪」。

### 存储位置

| 内容 | 位置 | 说明 |
|---|---|---|
| 灵感库 | `<dataRoot>/ideas.json` | 全局，跨项目；`dataRoot` 默认 `~/.plando` |
| 项目索引 | `<dataRoot>/projects.json` | `projectDir → projectId` |
| 机器状态 | `<projectDir>/.plando/state.json` | 唯一真相源，产物由它渲染；带 `schemaVersion` |
| 日志 | `<projectDir>/.plando/log.jsonl` | 每次推进/拒绝/降级留痕 |
| 检查清单 | `<projectDir>/.plando/checks.json` | 卡声明的可执行检查 |
| 卡片正文 | `<projectDir>/.plando/cards/<id>.md` | 人读副本 |
| 人读产物 | `<projectDir>/IDEA.md`、`TECH.md`、`HANDOFF.md`、`CHANGE-GUIDE.md` | 放在项目根，随项目 git 追踪 |

**写盘规则（分发包必需）**：所有 json 用「写临时文件 + `rename`」原子替换——多会话共享 `state.json`，半写文件比报错更糟。读到**已知的旧** `schemaVersion` 走 `migrate()` 升到当前版本后写回；只有**解析失败或版本未知**才报错停止，绝不静默重置。

### IDEA.md（渲染，结构校验）

一句话 / 谁用 / 做什么（MVP ≤5 条）/ 怎么算成（可观察验收 ≥1 条）/ 什么不做 / 关键假设（≥1，可证伪）/ 约束（预算·平台·技术偏好·每周小时·承诺风险）/ 用户基线。

### TECH.md（渲染，结构校验）

表格列：`id | 技术项 | 为什么需要 | 不会怎样错（影响什么判断）| 归属 | 难度1-3 | 预计分钟 | 过关判据 | 落在哪个文件`。

- `归属 ∈ {user, follow, ai}`：`user`=必须理解并自己写、`follow`=照步骤做、`ai`=可交给 AI。
- **预算硬上限**：`归属=user` 条数 ≤ `budget.mustUnderstand`（默认 5），`Σ分钟 ≤ budget.totalMinutes`（默认 600）。超了 `tech_ok` 被拒，提示「拆里程碑或降级」，避免清单膨胀到让人放弃。

---

## 四、工具（8 个，全部带阶段闸门）

| 工具 | 阶段 | 作用 |
|---|---|---|
| `plando_status` | 任意 | 读：阶段、下一步、未解问题、卡进度、产物清单、暂停/超时提醒 |
| `plando_project` | 任意 | `open/list/init`：定位项目、加载或初始化 `.plando/state.json`；状态损坏时**报错不重置** |
| `plando_idea` | 任意 | `add/list/pick/park/drop`；`pick` 要求三问全过（还想做/现在做/一个人做得完）+ `dir` |
| `plando_clarify` | clarify | `record`（detail / baseline）、`list`；一次一轮 ≤3 问，总轮数 ≤2 |
| `plando_transition` | 任意 | **唯一推进入口**。按事件校验 payload，成功则重渲染产物 + 落盘 + 记日志 + 自动提交 |
| `plando_card` | build | `start/done/downgrade/evidence`；`done` 必须有证据（检查输出或文件变化），不接受「我懂了」 |
| `plando_check` | build/ship | 只运行 `checks.json` 里**已声明**的命令，返回输出与退出码，结果进证据 |
| `plando_scaffold` | build | 只写白名单配置文件，且仅当对应 TECH 项 `归属=ai`；记录到日志 |

`plando_transition` 的 payload 承担结构化输入：`clarify_done{what,done,notDo,users,assumptions,constraints}`、`tech_ok{items[]}`、`choose_verify{hypothesis,method,timeboxMin,judge}`、`choose_build{cards[]}`、`verify_result{result,evidence}`、`ship_pass{offlineOk,selfChange,explain}`、`drop{reason}`、`revise{reason}`、`pause/resume/reopen`。全部由 `state.js` 校验，非法即报错并留痕。

---

## 五、守卫与「不代写」的落点

**结构性**（第一道）：预设不挂 `bash/pwsh/terminal/run_code/subagent/subagent_fork/workflow`；`dsh-tool-fs` 配 `write:false, edit:false`。模型根本看不到写文件工具。

**守卫**（第二道，`ctx.tools.guard()`，同步单调）：拒绝一切「能改变世界」的工具，理由里写明「现在在哪个阶段、下一步做什么」。状态读不出来时：写类工具**失败即拒**（fail-closed），只读工具放行。`plando_*` 不拦（自带阶段校验）。

拒绝名单**按能力列、不按记忆列**（名单在 `policy.js`，每条都有测试）：文件写（`write` / `edit` / `str_replace_editor` / `apply_patch`）、命令执行（`bash*` / `pwsh*` / `terminal*` / `shell*`）、动态代码（`run_code` / `code_interpreter` / `notebook*` / `eval*`）、委派（`subagent*` / `workflow` / `task`）。前缀匹配覆盖带后缀的变体；`config.guardExtraDeny` 允许用户追加工具名。这条名单与市场索引的能力词表对齐（`fs-write` / `shell` / `dynamic-code` / `subagent`），避免出现「市场标了能力、守卫却没拦」的缺口。

**配置/脚手架**（唯一例外）：`plando_scaffold` 按文件名白名单放行（精确名单，仅限项目根，v1 实装 7 项：`package.json`、`tsconfig.json`、`.gitignore`、`.env.example`、`pyproject.toml`、`requirements.txt`、`Cargo.toml`），且必须对应 `归属=ai` 的 TECH 项。名单是**白名单不是黑名单**：不在表里的路径一律拒绝，不做通配推导——v1 宁可少放行，也不给「文件名一改就绕过」留口子。

> 初稿名单有 11 项，实测后砍掉 4 项：`vite.config.js` / `vite.config.ts` 是可执行 JS，写进去就能被 `node vite.config.js` 跑起来，等于开了一个任意代码入口；`README.md` / `index.html` 是**用户的内容文件**不是配置文件，替用户写等于代写。内容维度也要校验：`package.json` 的 `scripts` 只认 `test` / `build` / `lint` 这类键，`postinstall` 之类的生命周期钩子一律拒（否则「AI 不代写」变成「AI 在你机器上预埋一条命令」）。**值**还要过命令白名单：串联（`&&` / `;` / `|` / 反引号 / `$(`）、环境变量前缀（`NODE_OPTIONS=…`）、非白名单命令名（`tar` / `bash` / `./x.sh`）一律拒，并复用 `checks.validateCommand` 的 argv 级校验——这条链的严重性在于 `plando_check` 会执行 `npm test`，所以「AI 埋命令」和「AI 执行命令」原本能自己闭环。见 `docs/REVIEW-tools.md` G2 / L5 / §9.3。

**读**永不拦：AI 要读用户写的代码才能验收。

---

## 六、预设（`cordis.patch.yml`）

```yaml
- insert:
    - id: preset-plan-do
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: plan-do
        name: 边学边做
        description: 把一个小想法一步步学会并做出来：AI 只教、只验收，不代写。
        order: 25
        plugins: [persona, agent-instructions, time-context, plan-do-mode,
                  tool-fs(write:false,edit:false), tool-fs-search, tool-ask-user,
                  skill-filesystem, tool-skill, tool-web, tool-present,
                  working-directory, compaction 组]
```

- **persona.prefix** 承载模式人格与铁律（约 2–4KB）：阶段与出口、卡内三段、卡住协议（20 分钟 → 提示分级：指方向 / ≤5 行片段 / 完整答案并标「未掌握」）、每卡必停、反作弊（不猜阶段、不用「我先准备一下」绕过、不写模板套话、TECH 每条必须有判据）、语气。
- **不挂 plan-mode**：两套流程叠加会互相打架（glim-mode 已验证）。
- 插件 `inject: ['tools']`，`workingDirectory` 用可选注入，拿不到时退回「由模型显式传 `dir`」。

---

## 七、自动提交（默认关闭）

**分发包不能在陌生人的仓库里默认写 git**：会撞上 hooks、签名、并发会话，以及用户正在改的代码。所以 `autoCommit` **默认 `false`**，需要时在 `cordis.patch.yml` 里显式打开：

```yaml
- id: plan-do-mode
  config: { autoCommit: true }
```

打开后，每次成功推进/写产物：`git add -- IDEA.md TECH.md HANDOFF.md CHANGE-GUIDE.md .plando` → 有暂存才 `git commit -m "plando(<stage>): <event>"`。**绝不 `git add -A`**，不碰用户正在写的代码；commit 正文带 `plan-do-mode` 标识便于识别与回滚。项目不是 git 仓库时跳过并提示一次，不报错。

> 本仓库自己的开发仍按 AGENTS.md 每次改动提交——那是**开发流程**的要求，不是插件对用户仓库的默认行为。

---

## 八、实施步骤（每步一个 commit）

1. **脚手架**：`package.json`、`icon.svg`、`locale/*`、`.gitignore` 补充、`README.md` 骨架。
2. **state.js + 测试**：阶段/事件/合法性/payload 校验/规模判定/预算校验/暂停/终态/reopen/revise。
3. **artifacts.js + 测试**：6 类产物渲染与结构校验（IDEA/TECH/VERIFY/HANDOFF/CHANGE-GUIDE/卡）。
4. **project.js + git.js + 测试**：项目定位、灵感库、索引、自动提交只含模式产物（用临时 git 仓库测）。
5. **cards.js + checks.js + scaffold.js + 测试**：卡生命周期、TECH 覆盖、检查命令执行（用 `node -e "process.exit(0)"` 这类无害命令）、白名单。
6. **policy.js + tools.js + index.js + 测试**：守卫规则、8 个工具、`apply()` 用假 ctx 跑通；零依赖导入 + 静态禁止裸包名。
7. **cordis.patch.yml + 提示词**：写预设与 persona 文本。
8. **docs/PROTOCOL.md + docs/INSTALL.md**：人读流程与安装/冒烟清单。
9. **分发包**：`LICENSE`、`files`/`exports` 白名单、`scripts/verify-pack.mjs`（断言 pack 清单完整）、`.github/workflows/test.yml`、README 的安装节（三条装法 + 卸载 + 能力说明）。
10. **全量验证**：`node --test` 全绿 + `node scripts/verify-pack.mjs` 通过 → 提交。

---

## 九、安装与冒烟验证

1. 在**有 `plugin_manager` 的会话**（创造模式 / `cordis` 预设）执行：
   `plugin_manager action=install_bundle target=A:\AI\plan-do-mode`
2. `plugin_manager list_plugins` 确认 `preset-plan-do` 激活、`application: applied`。
3. 新建会话选「边学边做」，在临时工作区跑冒烟：
   - 记一条灵感 → 三问 pick → 澄清 → IDEA.md 生成 → TECH.md 生成（含预算拦截用例）→ 选路 → 一张卡（学/做/验）→ 收尾。
   - 负向验证：让 AI「直接帮我写这个文件」→ 必须被拒/工具不存在；`plando_scaffold` 写 `package.json` 成功、写 `src/app.js` 被拒。
   - 检查 `.plando/state.json`、各产物、commit 历史。
4. **分发形态验证（A8 / A9）**：
   - `npm pack --dry-run --json` → `node scripts/verify-pack.mjs` 断言清单完整。
   - `npm pack` 出 tgz 后，用 `plugin_manager action=install_bundle target=<解包目录>` 装一次，确认预设列表出现「边学边做」。
   - 卸载（`plugin_manager action=remove_bundle`）→ preset 消失、`~/.plando` 仍在。

> 注：`plugin_manager` 不在当前会话工具集里，第 1–4 步需要你在创造模式会话里执行（或授权后由那边完成）；我这边能保证的是 A1（测试）、A8（pack 完整性）与文件正确性。

---

## 十、可分发的形态（npm 包 + GitHub Release tgz）

**结论**：v1 以「一个 npm 包 + 一个 GitHub Release tgz」双通道分发；`install_bundle` 只用于开发期冒烟。这个生态已有成熟先例——索引 `awesome-dsh-plugin.com/plugins.json` 收录 1.3 万个插件，其中「模式类预设」已有多个（`dsh-preset-deep`、`dsh-free-mode`），形态与本项目同构：`dsh.bundle.patch` + 一个 `cordis.patch.yml`，没有 UI、不需要构建。

### 10.1 三条装法

```bash
# ① npm（有版本号，可升级）
dsh plugin --profile desktop add dsh-plan-do

# ② GitHub Release tgz（不需要 npm 账号，国内网络更稳，推荐作主通道）
dsh plugin --profile desktop add -w "https://github.com/<owner>/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"

# ③ 开发期本地目录
plugin_manager action=install_bundle target=A:\AI\plan-do-mode
```

装完：新建会话的预设列表出现「边学边做」。卸载后 preset 消失，但 `~/.plando` 与项目 `.plando/` **保留**——卸载不删用户数据。

**实测修正（2026-11-25，本机验证）**：

- `dsh --profile desktop --dump-default-config` 直接报 `profile "desktop" is managed exclusively by the Electron application` —— 桌面 profile 由 Electron 应用独占管理。
- `dsh plugin --profile <name> <pnpm-args...>` 是 **pnpm 透传**（`list` 实测可用），所以 ① ② 大概率只完成「装依赖」这一半，**不一定把包名写进 `package.json` 的 `dsh.profile.bundles`**——桌面版这个列表由 dshmarket 或 `plugin_manager` 维护。

因此分工改成：

| 场景 | 走哪条 |
|---|---|
| 开发期 / 首次验证（本机） | ③ `plugin_manager action=install_bundle`（创造模式会话） |
| 发布后给别人（桌面版） | dshmarket 一键装（需要先进索引），或 `plugin_manager` 装本地目录 |
| 非桌面托管 profile（`web` / `tui` / `headless`） | ① ② 可用，必要时手动补 `dsh.profile.bundles` |

> A9 的验证按此改写：**用 `plugin_manager install_bundle` 装得上 + 卸得干净**；tgz 通道在桌面版上的激活方式待实测后再定论。

### 10.2 包元数据（照 `dsh-preset-deep` / `dsh-team-control` 的既有惯例）

- `"type": "module"`；`exports` 暴露 `.` / `./cordis.patch.yml` / `./locale/*.json` / `./icon` / `./package.json`
- `"files"` 白名单：`lib/`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`、`docs/`，再减 `!docs/REVIEW-*.md`
  （两份内部红队报告共约 150 KB，行号指向某个 commit、装包用户用不上；**留仓库、不进包**，
  `scripts/verify-pack.mjs` 会断言它们没被误打包）
- `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
- `keywords: ["dsh-plugin","dsh-bundle","deepseek-harness","agent-preset"]`（索引靠它发现）
- `license: "MIT"` + `repository` / `homepage` / `bugs` / `icon`
- **不需要** `dsh.client`（v1 无 UI）、**不需要** `peerDependencies`（零依赖）

### 10.3 零依赖保护不了的事：打包漏文件

`files` 白名单漏一项（例如 `locale/zh.json`），本地 link 安装一切正常，别人装完却是空标题——这是分发特有的失败模式。所以 `scripts/verify-pack.mjs` 跑 `npm pack --dry-run --json`，断言清单包含 `lib/` 下每个模块、`cordis.patch.yml`、两个 locale、`icon.svg`，缺一个即失败（对应 A8）。反向也要断言：`test/`、`scripts/`、`REVIEW-*.md` 这些**不该**跟包走的东西一旦混进去同样失败——「多打包」比「少打包」更不容易被用户发现。

### 10.4 与市场索引的关系（上架是后置项，但形态要提前对齐）

- **双语描述**：索引里每个插件都有 `description.en` / `description.zh`，要写成「这是什么模式、和别的模式差在哪」。
- **capabilities 由扫描得出，不认声明**：本包会被标 `shell`（`plando_check` 要执行命令）与 `fs-write`（`plando_scaffold`、写 `.plando/`）。README 必须主动说明：**「AI 不代写」是模式内部的硬约束，插件本身确有这两项能力**，否则上架后第一个质疑就是这一点。
- 上架 = 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR；不是 v1 的验收项。

### 10.5 仓库布局

v1 包就在仓库根（`npm publish` 从根发，`github:owner/repo` 也要求根有 `package.json`），人读文档（IDEA.md / TECH.md / docs / PROTOCOL.md）与包共用一棵树，靠 `files` 白名单隔离发布内容。monorepo 子目录形态（`add github:owner/repo#dsh-plugin`，`dsh-team-control` 就是这么发的）留到 v2。

## 十一、边界情况与失败模式

| 情况 | 处理 |
|---|---|
| `dataRoot` 不存在/不可写 | 自动创建；失败时明确报错并给出路径 |
| `.plando/state.json` 损坏 | 报错并停止，绝不静默重置（附 `schemaVersion` 与恢复建议） |
| `.plando/state.json` 是旧 schema | `migrate()` 升到当前版本后写回；迁移失败才报错 |
| 同一文件并发写 | 临时文件 + `rename` 原子替换；读前重载，冲突以文件为准 |
| 项目不是 git 仓库 | 跳过自动提交，提示一次（`autoCommit` 本就默认关闭） |
| 同一项目多会话 | 共享同一 `state.json`；每次读写前重载，冲突以文件为准 |
| 用户中途改需求 | `revise`：重渲染 IDEA.md、受影响卡标 `stale`、退回 tech |
| 卡住/想跳过 | 提示分级 → 降级为 `ai` 并标「未掌握」，记录留痕 |
| 验证超时 | 允许记录，但日志标 overtime 并在下次 status 提醒 |
| 状态读不出时守卫 | 写类工具 fail-closed，只读放行 |
| 预设 id 已被占用 | 装前检测 `preset-plan-do` 冲突，报错并给出改名指引，不覆盖 |
| 卸载 / 重装 | preset 与工具消失，`~/.plando`、项目 `.plando/` 与已渲染产物保留 |
| DSH 版本不兼容 | `apply()` 特性探测：拿不到 `ctx.tools.register` 或 `ctx.tools.guard` 时**抛错拒绝加载**（宁可挂不上，也别假装拦住了——见 API-FACTS §1）。降级成「无守卫」等于把不代写变成空话，不做 |

## 十二、明确不做（本版）

- 不做 UI 徽章/侧栏卡片（C 档），阶段靠 `plando_status` 查看；因此也不需要 `dsh.client`。
- 不改 `A:\AI\glim`，不复用其 core（避免跨仓库耦合）。
- 不做多灵感并行分支（v1 一条灵感一个项目；分支留到 v2）。
- 不接管 `todo_write`（不挂该工具，卡就是唯一清单）。
- 不自动改写用户代码、不自动执行用户未声明的命令。
- 不默认自动 commit（`autoCommit: false`，显式开启才提交）。
- v1 不上架市场索引、不做 monorepo 子目录分发（形态对齐即可，见第十节）。

## 十三、假设（若不成立请指出）

1. DSH 版本为 0.2.1-rc.2，预设/守卫/`plugin_manager` 行为与官方文档一致；`ctx.tools.guard` 与 glim-mode 实测一致。
2. 零依赖的理由已修正为「跨安装形态与跨 DSH 版本稳定」：`link:` 安装确实解析不到 `@deepseek-ai/*`（glim-mode 实测），但 npm / GitHub / tgz 安装能解析（`dsh-prompt-rewriter` 实测有真实 dependency）。
3. 分发命令 `dsh plugin --profile desktop add <npm 名 | github:owner/repo | -w <tgz>>` 与市场索引 `awesome-dsh-plugin.com/plugins.json` 里各插件 `install` 字段一致；本机 profile 名为 `desktop`。
4. 你在编辑器里手写项目代码，AI 通过 `read/grep/glob` 与 `plando_check` 验收。
5. 命名可按你偏好调整：包名 `dsh-plan-do`、预设 id `plan-do`、显示名「边学边做」、工具前缀 `plando_`、数据目录 `~/.plando`（都是一行改动）。
