# plan-do 模式：把一个小想法「学会并做出来」的 DSH 模式

> 状态：方案已定稿，尚未开工（0 行代码）
> 日期：2026-11-25
> 下一步：确认命名与安装方式后，按第八节 9 个步骤实施

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

---

## 二、交付物结构

```
A:\AI\plan-do-mode\
├─ package.json            # @local/plan-do-mode，dsh.bundle.patch
├─ cordis.patch.yml        # 插入 preset-plan-do（persona 提示词 + 插件清单）
├─ icon.svg                # 原创图标
├─ locale/en.json zh.json  # meta.title / meta.description
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
├─ test/*.test.js          # 7 个测试文件
└─ README.md
```

**硬约束：零依赖。** 只 import `node:` 内置模块和本目录文件。原因已由 glim-mode 实测：`install_bundle` 用 `link:` 链入 profile，被链目录没有自己的 `node_modules`，`@deepseek-ai/*` 裸包名解析必失败。因此工具用裸 `ToolDefinition` 对象（`parameters` 用原始 JSON Schema，`output: { schema:{type:'string'}, render }`），配置手工校验。

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
| 机器状态 | `<projectDir>/.plando/state.json` | 唯一真相源，产物由它渲染 |
| 日志 | `<projectDir>/.plando/log.jsonl` | 每次推进/拒绝/降级留痕 |
| 检查清单 | `<projectDir>/.plando/checks.json` | 卡声明的可执行检查 |
| 卡片正文 | `<projectDir>/.plando/cards/<id>.md` | 人读副本 |
| 人读产物 | `<projectDir>/IDEA.md`、`TECH.md`、`HANDOFF.md`、`CHANGE-GUIDE.md` | 放在项目根，随项目 git 追踪 |

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

**守卫**（第二道，`ctx.tools.guard()`，同步单调）：对 `write/edit/str_replace_editor/apply_patch/bash*/pwsh*/terminal*/run_code/subagent*/workflow` 一律拒绝，理由里写明「现在在哪个阶段、下一步做什么」。状态读不出来时：写类工具**失败即拒**（fail-closed），只读工具放行。`plando_*` 不拦（自带阶段校验）。

**配置/脚手架**（唯一例外）：`plando_scaffold` 按文件名白名单放行（`package.json`、`tsconfig*.json`、`*.config.{js,ts,mjs,cjs}`、`.gitignore`、`.env.example`、`Dockerfile`、`docker-compose*.yml`、`requirements.txt`、`pyproject.toml`、`Makefile`、`.editorconfig`、`.github/workflows/*.yml`），且必须对应 `归属=ai` 的 TECH 项。

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

## 七、自动提交（满足 AGENTS.md 的每次改动都提交）

每次成功推进/写产物后：`git add -- IDEA.md TECH.md HANDOFF.md CHANGE-GUIDE.md .plando` → 有暂存才 `git commit -m "plando(<stage>): <event>"`。**绝不 `git add -A`**，不碰用户正在写的代码。项目不是 git 仓库时跳过并提示，不报错。

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
9. **全量验证**：`node --test` 全绿 → 提交。

---

## 九、安装与冒烟验证

1. 在**有 `plugin_manager` 的会话**（创造模式 / `cordis` 预设）执行：
   `plugin_manager action=install_bundle target=A:\AI\plan-do-mode`
2. `plugin_manager list_plugins` 确认 `preset-plan-do` 激活、`application: applied`。
3. 新建会话选「边学边做」，在临时工作区跑冒烟：
   - 记一条灵感 → 三问 pick → 澄清 → IDEA.md 生成 → TECH.md 生成（含预算拦截用例）→ 选路 → 一张卡（学/做/验）→ 收尾。
   - 负向验证：让 AI「直接帮我写这个文件」→ 必须被拒/工具不存在；`plando_scaffold` 写 `package.json` 成功、写 `src/app.js` 被拒。
   - 检查 `.plando/state.json`、各产物、commit 历史。

> 注：`plugin_manager` 不在当前会话工具集里，第 1–3 步需要你在创造模式会话里执行（或授权后由那边完成）；我这边能保证的是 A1（测试）与文件正确性。

---

## 十、边界情况与失败模式

| 情况 | 处理 |
|---|---|
| `dataRoot` 不存在/不可写 | 自动创建；失败时明确报错并给出路径 |
| `.plando/state.json` 损坏 | 报错并停止，绝不静默重置（附 `schemaVersion` 与恢复建议） |
| 项目不是 git 仓库 | 跳过自动提交，提示一次 |
| 同一项目多会话 | 共享同一 `state.json`；每次读写前重载，冲突以文件为准 |
| 用户中途改需求 | `revise`：重渲染 IDEA.md、受影响卡标 `stale`、退回 tech |
| 卡住/想跳过 | 提示分级 → 降级为 `ai` 并标「未掌握」，记录留痕 |
| 验证超时 | 允许记录，但日志标 overtime 并在下次 status 提醒 |
| 状态读不出时守卫 | 写类工具 fail-closed，只读放行 |

## 十一、明确不做（本版）

- 不做 UI 徽章/侧栏卡片（C 档），阶段靠 `plando_status` 查看。
- 不改 `A:\AI\glim`，不复用其 core（避免跨仓库耦合）。
- 不做多灵感并行分支（v1 一条灵感一个项目；分支留到 v2）。
- 不接管 `todo_write`（不挂该工具，卡就是唯一清单）。
- 不自动改写用户代码、不自动执行用户未声明的命令。

## 十二、假设（若不成立请指出）

1. DSH 版本为 0.2.1-rc.2，预设/守卫/`plugin_manager` 行为与官方文档一致；`ctx.tools.guard` 与 glim-mode 实测一致。
2. 被 `link:` 安装的 bundle 解析不到 `@deepseek-ai/*` 裸包名（glim-mode 实测），因此零依赖是硬约束。
3. 安装走 `plugin_manager install_bundle`，需创造模式会话（当前会话无该工具）。
4. 你在编辑器里手写项目代码，AI 通过 `read/grep/glob` 与 `plando_check` 验收。
5. 命名可按你偏好调整：预设 id `plan-do`、显示名「边学边做」、工具前缀 `plando_`、数据目录 `~/.plando`（都是一行改动）。
