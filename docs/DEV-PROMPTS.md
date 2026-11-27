# DEV-PROMPTS.md：把实现工作交给另一个 AI 的提示词方案

> 这份文件不是给人读的说明，而是**可直接复制的操作手册**：
> 每一轮 = 粘贴「固定前缀」+ 粘贴「本轮任务卡」→ AI 干活 → 你贴「验收命令」看结果 → 过了就 commit。
>
> 配套文件：[CONTRACT.md](CONTRACT.md)（写什么）、[API-FACTS.md](API-FACTS.md)（DSH API 怎么用）。

---

## 一、三条使用规则

1. **一轮一个任务卡，不要一次把 PLAN.md 丢给它。** 整份 PLAN 给过去，AI 会把它压成「先写个大框架」，
   然后一次性生成十几个互相不认识的文件——最后拼不起来，而且你没法定位是哪一轮错的。
2. **提示词里只写「可判定的验收命令」，不写「请保证代码质量」。** 质量不可判定，AI 会自己定义「质量」。
   可判定的东西：`node --test test/state.test.js` 全绿、`registered.map(d=>d.name)` 等于某数组、`grep` 结果为空。
3. **每轮以一次 commit 收口，并让 AI 贴出证据**（测试输出尾部 + `git log --oneline -1`）。
   没有证据的「已完成」一律视为未完成，退回同一轮重做。

---

## 二、提示词的三层结构

| 层 | 内容 | 什么时候贴 |
|---|---|---|
| **L1 固定前缀** | 项目宪法：仓库路径、必读文件、零依赖、测试与提交规范、禁止清单 | **每一轮都贴**（新会话必贴） |
| **L2 任务卡** | 本轮目标 / 产出文件 / 函数签名 / 验收命令 / 禁止事项 | 每轮贴一张 |
| **L3 验收卡** | 换一个 AI 做红队审查，找「验收造假」和「能绕过的路径」 | 每 2 轮贴一次，或大轮之后 |

为什么 L1 要每轮重复：AI 会话之间没有记忆，而「零依赖」「不许改验收标准」这类约束一旦漏贴，
它一定会违反——不是它不听话，是它不知道。

---

## 三、L1 固定前缀（每次必贴，原样复制）

```text
你在 A:\AI\plan-do-mode 这个仓库里实现一个 DSH 插件项目（plan-do 模式）。工作目录就是仓库根。

【先读这四个文件，读完再动手】
1. PLAN.md            —— 项目方案与验收标准（A1–A9）。这是需求，不是建议。
2. docs/CONTRACT.md   —— state.js 的精确契约：阶段枚举、事件表、payload 字段、错误消息规范。
3. docs/API-FACTS.md  —— DSH 插件 API 的已验证事实。凡 API 用法以它为准，不要凭印象。
4. AGENTS.md          —— 仓库规矩。

【硬约束（违反即视为本轮失败）】
- 零依赖：lib/ 下只允许 import 'node:*' 内置模块和本目录文件。禁止 import 任何 @deepseek-ai/* 或其他裸包名。
  原因见 docs/API-FACTS.md §4。工具定义手工拼纯对象，不用 defineTool；配置手工校验，不用 schemastery。
- 不改 A:\AI\glim，不复用它的代码。只读它作为 API 参考。
- 不写 UI、不加 client 端代码、不装任何 npm 依赖、不创建 node_modules。
- 不改 PLAN.md 的验收标准，不降低任何校验的严格程度。如果某条验收你认为做不到，停下来告诉我，不要自己改判据。
- 测试只用 node:test + node:assert/strict；测试里的临时目录用 fs.mkdtempSync(os.tmpdir())，
  绝不允许写 ~/.plando 或用户真实项目目录。
- 中文注释、中文错误消息；错误消息格式见 docs/CONTRACT.md §5。
- 每次改动后：先跑 node --test 全绿，再 git commit（一次 commit 只包含本轮产出的文件）。
  commit message 用 conventional commits（feat/test/docs/chore），中文正文，说明改了什么、验收怎么过的。
- **单次写入 ≤180 行**：一个 write 或一次 edit 的内容不超过 180 行。要写更长的文件，
  先 write 骨架（导出签名 + 一行 TODO），再用 edit 逐段填充。**不要一条消息里吐 500 行代码。**

【工作方式】
- **先落笔，再迭代**：如果发现自己在长篇推演实现细节（超过 30 行 reasoning），立刻停下，
  先写出能跑的最小骨架，让 `node --test` 告诉你哪里错。这个仓库的验收靠测试，不靠「想清楚了」。
- 只做本轮任务卡里列出的文件。需要动别的文件，先问我。
- 做完后按顺序贴三样东西：① 改动的文件清单 ② node --test 的输出尾部（通过数/失败数）③ git log --oneline -1。
- 不确定的地方停下来问，不要猜。猜错的代价比问一句高得多。
```

---

## 四、逐轮任务卡（L2，按顺序贴）

> 顺序不能换：后面的轮次 import 前面的文件。每张卡里的「产出」就是该轮的写入范围，别越界。

### R0 脚手架

```text
【本轮目标】只搭骨架，不写任何业务逻辑。

【产出】
- package.json：name "dsh-plan-do"，version "0.1.0"，type "module"，private 不设，
  description 一句中文，license "MIT"，keywords ["dsh-plugin","dsh-bundle","deepseek-harness","agent-preset"]，
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }，
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml",
               "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg", "./package.json": "./package.json" }，
  "files": ["lib","cordis.patch.yml","locale/*.json","icon.svg","README.md","README.zh.md","LICENSE","docs"]，
  "scripts": { "test": "node --test", "verify-pack": "node scripts/verify-pack.mjs" }。
  不要写 dependencies / devDependencies。
- LICENSE：MIT 全文。
- locale/en.json、locale/zh.json：{ "meta": { "title": "...", "description": "..." } }，两语各一份。
- icon.svg：原创、纯矢量、256x256 视框、无外部引用。
- README.md 骨架（英文，GitHub 首页）：一句话是什么、三条装法（npm / tgz / 本地 bundle）、装了之后怎么用、能力说明（见 PLAN 第十节）；中文版放 README.zh.md，两份互相链接。
- .gitignore 补充：node_modules/、*.tgz、.plando/。

【验收命令】
node -e "const p=require('./package.json'); const a=['type','exports','files','dsh','scripts']; for(const k of a){ if(!p[k]) throw new Error('missing '+k) } if(p.dependencies||p.devDependencies) throw new Error('must stay zero-dep'); console.log('ok')"
node -e "const zh=require('./locale/zh.json'),en=require('./locale/en.json'); if(!zh.meta.title||!en.meta.title) throw new Error('bad locale'); console.log('ok')"

【禁止】不写 lib/ 下任何文件；不写 cordis.patch.yml（下一轮才写）。
```

### R1a state.js 骨架（常量与转移表）

```text
【本轮目标】只写 lib/state.js 的「数据部分」：阶段、标签、下一步、转移表、初始状态。
不写校验逻辑、不写测试（下一轮写）。

【产出】lib/state.js，本轮只导出这 6 个常量：
- SCHEMA_VERSION = 1
- STAGES：11 项，顺序照 CONTRACT §1
- TERMINAL_STAGES：['done','handoff','dropped']
- STAGE_LABELS：每个阶段一句中文名（澄清 / 技术拆解 / 选路 / 小验证 / 边做边学 / 收尾验收 / 已完成 / 已交接 / 已放下 / 灵感 / 想法定稿）
- NEXT_ACTIONS：每个阶段一句「下一步做什么」，中文，≤40 字
- TRANSITIONS：{ [event]: { from: string[], to: string } }，照 CONTRACT §2 表格**逐行**抄，
  14 个事件一个都不能少；`drop` 的 from 写 ['inbox','clarify','idea','tech','decide','verify','build','ship']；
  `pause`/`resume` 的 from 同样列全非终态；`reopen` 的 from 写 ['done','handoff','dropped']。
文件末尾留一行 `// TODO(R1b): canTransition / validatePayload / applyEvent / computeSize / checkBudget / migrate / createInitialState`

【验收命令】
node -e "import('./lib/state.js').then(m=>{if(m.STAGES.length!==11)throw new Error('stages');if(Object.keys(m.TRANSITIONS).length!==14)throw new Error('events');console.log('ok')})"

【禁止】不写测试、不写渲染、不碰文件系统；本文件不要超过 120 行。
```

### R1b state.js 校验与推进

```text
【本轮目标】在现有 lib/state.js 上补齐纯函数逻辑（用 edit 追加，不要重写整个文件）。

【产出】lib/state.js 追加导出：
- canTransition(state, event) -> boolean
- validatePayload(event, payload, config) -> { ok, reason? }
- applyEvent(state, event, payload, config) -> { ok, state?, reason?, effects? }
- computeSize(items, constraints) -> { size, sizeReason, totalMinutes }
- checkBudget(items, budget) -> { ok, reason? }
- migrate(state) -> { ok, state?, reason? }
- createInitialState(project) -> state

【关键要求】
- 纯函数；不改传入的 state（返回新对象）。
- 非法转移返回 { ok:false, reason }，reason 照 CONTRACT §5 的形状。
- 预算/规模照 CONTRACT §3；超预算的 reason 要同时出现「超了多少」和「怎么降级」。
- revise：受影响卡标 stale（受影响 = techIds 与变更项有交集），stage 退回 tech。
- migrate：缺失或更旧 → 升级；更高版本或不可解析 → 返回错误，**绝不返回空状态**。

【验收命令】
node --test   # 此时还没有测试文件，应为 0 tests、exit 0；真正的验收在 R1c
node -e "import('./lib/state.js').then(m=>{for(const f of ['canTransition','validatePayload','applyEvent','computeSize','checkBudget','migrate','createInitialState']) if(typeof m[f]!=='function') throw new Error('missing '+f); console.log('ok')})"

【禁止】本轮仍不写测试；单次写入 ≤180 行，超了就用多次 edit 分段追加。
```

### R1c state.test.js（分成三个文件）

```text
【本轮目标】给 state.js 补测试。**拆成三个测试文件**，一次只写一个。

【产出】按顺序写，每写完一个跑一次 node --test：
1. test/state.transitions.test.js
   覆盖 CONTRACT §2 表格的每一行：每行一个合法用例 + 一个「错误阶段调用」的非法用例；
   另测 pause/resume 的幂等、reopen 清 terminal、非法 event 名。
2. test/state.payload.test.js
   覆盖 §3：clarify_done 七个字段缺失各一次、assumptions 为空、
   done 只写「功能都实现了」被拒、baseline 越界；
   tech_ok 每项 9 字段缺失、owner 非法、difficulty 越界；
   choose_verify 的 timeboxMin 边界（0 / 60 / 61）；verify_result 的 result 非法值。
3. test/state.budget.test.js
   覆盖 §3 预算与规模：user 条数超限、总分钟超限（reason 含两个数字）、
   totalMinutes>阈值（默认 300，可被 config.sizeThresholdMinutes 覆盖）判 large、
   阈值边界 300/301、非法阈值退回默认、promiseRisk 判 large、large 时 decide 推荐必须 verify。

【关键要求】
- 只断言必须为真的东西：错误消息用正则匹配关键片段（如 /阶段/、/预算/），不要断言整句文案。
- 用例之间不共享可变状态；每个用例自己造 state（可以写一个 makeState(overrides) 帮助函数）。
- 测试里不许出现 Date.now() 断言、不许写真实目录。

【验收命令】
node --test
node --test test/state.transitions.test.js test/state.payload.test.js test/state.budget.test.js

【禁止】不为了让测试变绿而改动 CONTRACT 的判据；发现契约本身自相矛盾，停下来问。
```

### R2 artifacts.js

```text
【本轮目标】实现「从 state 渲染全部产物」的纯函数模块 + 结构校验。

【产出】
- lib/artifacts.js，导出：
  renderIdea(state) -> string, renderTech(state) -> string, renderVerify(state) -> string,
  renderHandoff(state) -> string, renderChangeGuide(state) -> string, renderCard(state, card) -> string,
  checkIdeaStructure(text) -> string[]（返回缺失的小节标题，空数组表示完整）,
  checkTechStructure(text) -> string[]
- test/artifacts.test.js

【关键要求】
- 标题/列名逐字照 CONTRACT §6，一个字符都不能差（测试用 === 断言整行）。
- 渲染函数是纯函数：同样的 state 必须得到逐字节相同的字符串（不要有 Date.now()、随机数、Map 迭代顺序依赖）。
- TECH.md 表格要按 owner 分组（user 在前），并在表格下方汇总「user 项 N 条 / 总计 M 分钟 / 预算 X」。
- 卡片正文必须有「学 / 做 / 验」三段小标题，且每段都要能落成可执行判据（照 CONTRACT §6）。

【验收命令】
node --test test/artifacts.test.js
node -e "import('./lib/artifacts.js').then(m=>{console.log(typeof m.renderIdea, typeof m.checkTechStructure)})"

【禁止】不写文件（渲染只返回字符串；落盘是下一轮 project.js 的事）。
```

### R3 config.js + project.js + git.js

```text
【本轮目标】让状态能落到磁盘、能定位项目、能安全提交。这一轮第一次碰真实文件系统，务必用临时目录测。

【产出】
- lib/config.js：readConfig(raw) -> { dataRoot, budget, defaultProjectDir, autoCommit, guardExtraDeny, sizeThresholdMinutes }
  校验规则：dataRoot 为空则默认 os.homedir()/.plando；budget 缺省 { mustUnderstand:5, totalMinutes:600 }；
  sizeThresholdMinutes 缺省 300（正整数，判「大项目」的总分钟阈值）；
  autoCommit 默认 false（布尔强转）；非法值抛中文错误。
- lib/project.js：openProject(dir)、initProject(dir)、listProjects()、loadState(dir)、saveState(dir, state)、
  readIdeas()、writeIdeas(list)、原子写（写 .tmp 再 rename）。
- lib/git.js：commitArtifacts(dir, message) —— 只 git add -- IDEA.md TECH.md HANDOFF.md CHANGE-GUIDE.md .plando，
  绝不 git add -A；不是 git 仓库时返回 { skipped:true, reason }，不抛错。
- test/config.test.js、test/project.test.js、test/git.test.js

【关键要求】
- state.json 损坏（JSON 解析失败）→ 抛错并附带 schemaVersion 与恢复建议，绝不静默重置。
- 所有写入用「临时文件 + fs.renameSync」原子替换。
- 测试一律在 fs.mkdtempSync 出来的临时目录里跑，测完删掉；绝不碰 ~/.plando。
- git 测试要真的 git init 一个临时仓库，验证：模式产物进 commit、用户自己写的文件不进 commit。

【验收命令】
node --test test/config.test.js test/project.test.js test/git.test.js

【禁止】不改 R1/R2 的导出签名；不在这一轮写工具定义。
```

### R4 cards.js + checks.js + scaffold.js

```text
【本轮目标】任务卡生命周期、检查命令执行、配置脚手架白名单。

【产出】
- lib/cards.js：createCards(state, defs)、startCard(state, id)、doneCard(state, id, evidence)、
  downgradeCard(state, id, reason)、setEvidence(state, id, evidence)、cardProgress(state)
  —— done 必须有证据（检查输出或文件变化），没有就返回 ok:false。
- lib/checks.js：declareCheck(dir, card, command)、runCheck(dir, name) ——
  **只运行 checks.json 里已声明的命令**，返回 { exitCode, stdout, stderr }；拒绝未声明的命令。
- lib/scaffold.js：writeScaffold(dir, relativePath, content, techItem) ——
  文件名白名单（照 PLAN §5），且 techItem.owner 必须是 'ai'，否则拒绝。
- test/cards.test.js、test/checks.test.js、test/scaffold.test.js

【关键要求】
- 白名单/拒绝矩阵要在测试里逐条列出来（放行哪些、拒绝哪些），不要只测两个例子。
- checks 执行用 child_process.execFileSync，带 timeout（默认 60s），
  测试里用 node -e "process.exit(0)" 这类无害命令。
- scaffold 拒绝时 reason 要说明「这个文件不在白名单」或「对应 TECH 项归属不是 ai」。

【验收命令】
node --test test/cards.test.js test/checks.test.js test/scaffold.test.js

【禁止】不让 scaffold 写任意路径（必须 resolve 后仍在项目目录内）。
```

### R5 policy.js + format.js + tools.js + index.js

```text
【本轮目标】把前面所有模块接成 8 个工具 + 一个守卫。这一轮结束后项目就能装了。

【产出】
- lib/policy.js：MUTATING_TOOL_NAMES、MUTATING_PREFIXES、isMutatingTool(name)、
  denialFor({stage, stageLabel, paused, hasProject, toolName, nextAction, extraDeny}) -> string|undefined
- lib/format.js：formatStatus(state) -> string（短句，不要 JSON）
- lib/tools.js：createTools({ store, config }) -> ToolDefinition[]，8 个工具：
  plando_status / plando_project / plando_idea / plando_clarify / plando_transition / plando_card / plando_check / plando_scaffold
- lib/index.js：export const name = 'plan-do-mode'; export const inject = ['tools']; export function apply(ctx, config)
- test/policy.test.js、test/tools.test.js、test/plugin.test.js

【关键要求】
- 工具定义是纯对象（照 docs/API-FACTS.md §2），每个 execute 自己做参数校验，缺参数抛「缺少必填参数 x」。
- 每个工具都有阶段闸门：不在允许阶段调用 → 抛符合 CONTRACT §5 的中文错误。
- 守卫：写类工具在非 build 阶段一律拒绝；状态读不出来时写类 fail-closed、只读放行；
  plando_* 不拦（自带阶段校验）。拒绝理由必须包含当前阶段和下一步。
- apply 里拿不到 ctx.tools.register 或 ctx.tools.guard → 直接抛错。
- test/plugin.test.js 必须有四条地基用例（见 docs/API-FACTS.md §5）：
  裸 node 导入成功、lib/ 静态禁裸包名、注册的 8 个工具名完全匹配、守卫对 write 返回字符串而对 read 返回 undefined。

【验收命令】
node --test
node -e "import('./lib/index.js').then(m=>console.log(m.name, m.inject.join(',')))"
grep -rn "@deepseek-ai/" lib/ || echo "no bare package imports: ok"

【禁止】不引任何包；不把状态存内存；不在工具里调 git（那是 project/git 的事）。
```

### R6 预设与人格提示词

```text
【本轮目标】写 cordis.patch.yml 和 persona 提示词。这一轮几乎全是文字，但决定了模式到底拦不拦得住。

【产出】
- cordis.patch.yml：照 docs/API-FACTS.md §6 的写法，插入 preset-plan-do：
  id "plan-do"，name "边学边做"，description 一句，order 25，
  plugins 列表 = persona（prefix 内联）+ agent-instructions + time-context + plan-do-mode
  + tool-fs（config: { write:false, edit:false }）+ tool-fs-search + tool-ask-user
  + skill-filesystem + tool-skill + tool-web + tool-present + working-directory + compaction 组。
  **不要**挂 tool-bash / tool-pwsh / tool-jobs / tool-schedule / tool-subagent / tool-workflow / plan-mode。
- persona 的 prefix 内联在 yml 里，2000–4000 字中文，必须包含：
  ① 阶段与出口（照 CONTRACT §1/§2，用自然语言说，不要贴 JSON）
  ② 卡内固定三段：学 → 做 → 验
  ③ 卡住协议：20 分钟没进展 → 先指方向 / 再给 ≤5 行片段 / 最后才给完整答案并标「未掌握」
  ④ 每卡必停：做完一张卡必须停下来等用户确认，不许连做两张
  ⑤ 反作弊：不猜阶段（先 plando_status）、不用「我先准备一下」绕过守卫、不写模板套话、
     TECH 每条必须有可判定判据、不替用户写项目代码
  ⑥ 语气：像一个有耐心的带教，不像客服
- test/preset.test.js：断言 yml 里含 preset-plan-do、plan-do-mode 的 name 是 dsh-plan-do、
  prefix 长度 > 2000 且 < 8000、且不含 'tool-bash'。

【验收命令】
node --test test/preset.test.js
node -e "const t=require('fs').readFileSync('cordis.patch.yml','utf8'); ['preset-plan-do','边学边做','dsh-plan-do','write: false'].forEach(k=>{if(!t.includes(k)) throw new Error('missing '+k)}); console.log('ok')"

【禁止】不在这轮改 lib/ 代码（如果发现要改，先告诉我）。
```

### R7 分发包 + 文档 + 全量验证

```text
【本轮目标】让这个项目能被别人一条命令装上，并把验证跑完。

【产出】
- scripts/verify-pack.mjs：跑 npm pack --dry-run --json，断言清单包含
  lib/ 下每个 .js、cordis.patch.yml、locale/en.json、locale/zh.json、icon.svg、README.md、README.zh.md、LICENSE；
  缺一个就 process.exit(1) 并打印缺哪个。
- .github/workflows/test.yml：ubuntu + windows 两平台跑 node --test 和 npm run verify-pack。
- docs/PROTOCOL.md：人读流程——阶段、每个出口的判据、卡住协议、常见问题。
- docs/INSTALL.md：三条装法 + 卸载 + 冒烟验证清单（照 PLAN 第九节）。
- README.md 补全：一句话、三条装法、预设名「边学边做」、能力说明（有 shell 与 fs-write，见 PLAN 第十节）。

【验收命令】
node --test
node scripts/verify-pack.mjs
git status --short   # 应该是空的

【禁止】不改验收标准；不为了让 verify-pack 通过而把文件从 files 白名单里删掉。
```

---

## 五、L3 验收卡（换一个 AI 做红队，每 2 轮贴一次）

```text
你是这个项目的红队审查者，不是实现者。工作目录 A:\AI\plan-do-mode。
请读 PLAN.md 的验收标准、docs/CONTRACT.md、docs/API-FACTS.md，然后审最近的实现。

只找下面六类问题，每条都要给出**文件:行号**和**能复现的命令或最小输入**：
1. 验收造假：测试断言比 CONTRACT 要求更宽松（比如只断言 ok:true，不断言 reason 内容）。
2. 守卫缺口：有没有一条路径能让模型在非 build 阶段改动项目文件
   （子代理？workflow？scaffold 白名单绕过？路径穿越？符号链接？）。
3. 状态说谎：产物文件的内容与 state.json 不一致的路径（比如 revise 后没重渲染）。
4. 静默失败：出错时返回 ok:true、吞掉异常、或把损坏的 state 当空状态重建。
5. 越权写：写到了项目目录之外（dataRoot、临时目录、盘根）。
6. 依赖泄漏：lib/ 下出现裸包名，或用到了非 node: 内置模块。

不要给改进建议，不要重写代码。只列问题清单，按严重程度排序。
如果某一类没找到问题，明确写「未发现」——不要为了凑数编问题。
```

---

## 六、纠偏提示词（AI 跑偏时用）

**A. 它引了依赖 / 用了 defineTool**

```text
停。你违反了零依赖约束：<文件:行号> 出现了 <包名>。这个包在 link 安装形态下会 ERR_MODULE_NOT_FOUND，
整个插件会显示「加载失败」。请改回纯对象 ToolDefinition + 手工参数校验，参考 docs/API-FACTS.md §2 和 §4。
改完跑 node --test，并贴出 grep -rn "@deepseek-ai/" lib/ 的结果。
```

**B. 它改了验收标准或把校验放宽了**

```text
停。你改的是验收标准，不是实现：<文件:行号>。PLAN.md 的验收标准不能改，CONTRACT 的校验不能放宽。
如果某条验收你认为做不到，把「为什么做不到 + 你建议的替代判据」写给我，由我决定，不要自己改。
先把改动回退到上一个 commit，然后按原判据重做。
```

**C. 它一轮做太多 / 一次生成一堆文件**

```text
停。本轮任务卡只要求产出 <文件列表>，你动了 <多出来的文件>。
请回退多余改动，只保留任务卡范围内的产出。剩下的部分我会在下一轮单独给你。
```

---

## 七、接续提示词（上下文快满时，让它先写交接）

```text
上下文快满了。在结束前写一份 docs/HANDOFF-<轮次>.md，包含：
1. 本轮已完成（逐文件，含验收命令的实际输出结论）
2. 本轮未完成 / 半成品（明确哪些函数是空壳）
3. 下一轮应该做什么（具体到文件和函数签名）
4. 踩过的坑（一句话一条，附文件:行号）
5. 需要我决定的问题
不要继续实现。写完就停。
```

新会话开头：**L1 固定前缀 + `先读 docs/HANDOFF-<轮次>.md，然后继续。`**

---

## 八、反模式清单（AI 十有八九会做的，写进 L1 已经拦了一部分）

| # | 反模式 | 后果 | 拦它的地方 |
|---|---|---|---|
| 1 | `import { defineTool } from '@deepseek-ai/dsh-tools'` | 插件加载失败 | L1 硬约束 + R5 静态测试 |
| 2 | 装 `zod` / `js-yaml` 做校验或解析 | 同上 | L1 硬约束 |
| 3 | 把 stage 存在模块级变量里 | 换会话丢状态，与「状态不能说谎」冲突 | R1 纯函数要求 + R5 禁止项 |
| 4 | 用 `write` 工具写产物 | 自己撞自己的守卫 | API-FACTS §7 |
| 5 | `git add -A` | 提交用户正在写的代码 | R3 验收 |
| 6 | state 坏了就重置成初始状态 | 用户数据丢失，且没人知道发生过 | R3 明确禁止 |
| 7 | 校验放宽以让测试通过 | 验收形同虚设 | L3 验收卡第 1 类 |
| 8 | 一次做完 3 轮的任务 | 无法定位错误，commit 混杂 | 纠偏 C |
| 9 | 把 persona 提示词写成功能清单 | 模型照样绕过守卫 | R6 六条要求 |
| 10 | 给每个阶段都写一个专用推进工具 | 工具数量爆炸，模型选错 | CONTRACT §2 事件表 |
| 11 | 在测试里写真实 `~/.plando` | 污染开发机 | L1 测试约定 |
| 12 | 自作主张加 UI / client 端 | 超出 v1 范围，且需要构建链 | L1 硬约束 |
| 13 | 一条消息里吐 500 行代码 | **撞输出 token 上限，回答被截断**（实测踩过） | L1「单次写入 ≤180 行」+ R1a/b/c 拆分 |
| 14 | 长时间 reasoning 里推演实现细节 | 推理本身计入输出 token，同样触发截断（实测 R1 四次截断，推理占 10 万字符） | L1「先落笔再迭代：reasoning 超 30 行就停下」 |

---

## 九、撞到输出 token 上限怎么办（实测排查记录）

**症状**：对话里出现「已达到输出 token 上限 / 回答被截断，已有输出保留在对话中」，R1 反复卡住不产出文件。

**实测数据**（本机 `~/.dsh/sessions` 会话日志，R1 那四次）：

| turn | 输出 token | 内容 | stopReason |
|---|---|---|---|
| 3 | 43344 | 纯 reasoning，108701 字符 | `length` |
| 4 | 32768 | reasoning 97685 字符 + 一句「现在开始 R1」 | `length` |
| 5 | 32768 | 纯 reasoning | `length` |
| 6 | 32768 | 纯 reasoning | `length` |

关键结论：**推理（reasoning）算输出 token**。模型没有在写代码，而是在「想怎么写 state.js」上把预算烧光了。
`write` 一个字都没发出去，所以文件不存在、`node --test` 无事可测。

**三层原因**（从近到远）：

1. **任务卡太大**：R1 原来要求「一个 800+ 行的 state.js + 覆盖 14 个事件的完整测试」一次交付。
2. **模型的推理刹不住**：它反复自我推演「字段名该叫什么 / 错误消息怎么写」，越想越长，
   直到撞上限。这不是模型坏，是任务粒度大到一个响应装不下。
3. **provider 单请求输出上限**（`maxTokens`）：本机 `bananarouter/deepseek-v4.1-flash`
   实测在 32768 处截断（`model.maxTokens` 或 adapter 的 `defaultMaxTokens` 决定）。
   这一层即使调大也不能根治——1M 上下文里塞不下「一次写完整个地基」。

**已经做的修正**（本仓库）：

- R1 拆成 **R1a（常量与转移表）/ R1b（校验与推进）/ R1c（测试，且再拆三个文件）**。
- L1 加两条硬约束：**单次写入 ≤180 行**、**reasoning 超 30 行就停下先落笔**。
- 反模式清单补第 13、14 条。

**如果还是撞上限，按顺序试**：

1. **「继续」**：UI 提示里就写了——发送「继续」让模型接着输出。这只救「差一点」的情况。
2. **让它分段写**：`先只写 R1a 的 TRANSITIONS，写完就停，不要写别的`。
   一段一段来，比一次给一大段稳。
3. **换更小的推理强度**（如果模型支持）：推理少 → 留给正文的输出预算多。
   本机模型走 `bananarouter`，推理强度在模型选择器里调。
4. **调大该模型的输出上限**：设置 → 模型 → 该提供方 → 模型行 →「最大输出 token 数」。
   只是把天花板抬高，不解决「一次写太多」。
5. **换会话**：一次会话里堆了太多推理历史（实测 input 从 774 涨到 46355），
   模型会越推越长。写 `docs/HANDOFF-<轮次>.md` 然后开新会话。

> 注意：**不要把输出上限调到接近上下文窗口**。推理 + 正文 + 工具参数都算输出，
> 上限过大只会在更晚的地方以更贵的方式截断。

---

## 十、建议的会话节奏

| 轮次 | 预计产出 | 之后做什么 |
|---|---|---|
| R0 | 6 个文件，无逻辑 | `git commit -m "chore: 脚手架"` |
| R1a | state.js 的常量与转移表（≤120 行） | commit |
| R1b | 校验与推进函数（分段 edit） | commit |
| R1c | 三个测试文件 | 全绿后 commit；跑一次 L3 验收卡 |
| R2 | artifacts.js + 测试 | commit |
| R3 | config/project/git + 测试 | commit；跑 L3 验收卡（这轮最容易越权写） |
| R4 | cards/checks/scaffold + 测试 | commit；跑 L3 验收卡（白名单绕过） |
| R5 | policy/format/tools/index + 测试 | commit；**这里第一次能装**，装一次试试 |
| R6 | 预设 + persona + 测试 | commit；装好后目视确认「边学边做」出现在预设列表 |
| R7 | 分发包 + 文档 + 全量验证 | `npm pack` + `verify-pack` → 用 `plugin_manager install_bundle` 装一次 → 卸载 → commit |

每轮结束你只需要看三样：**测试通过数**、**git log**、**有没有动到任务卡以外的文件**。

---

## 十一、还缺的输入（开工前需要你定的）

> **已定（2026-11-25，四项全部确认；仓库地址同日补齐）**：① 包名 `dsh-plan-do`，
> 仓库 `github.com/MrLiu-Mo/plan-do-mode`（README / PLAN 的占位符已换成真值）；② 预算照用
> `{ mustUnderstand: 5, totalMinutes: 600 }`；③ persona 篇幅 2000–4000 字（R6 已按此实现并有断言）；
> ④ `docs/` 进 npm 包，但排除 `docs/REVIEW-*.md`（内部红队报告留在仓库，`package.json` 的
> `files` 用 `!docs/REVIEW-*.md`）。
> 下面四条原文保留，作为「当初为什么问」的记录。

1. **包名与仓库地址**：现在按 `dsh-plan-do` / `github.com/<owner>/plan-do-mode` 占位，
   R0 和 R7 都要用真实值。
2. **`budget` 默认值**：CONTRACT 用的是 PLAN 的 `{ mustUnderstand: 5, totalMinutes: 600 }`，是否照用。
3. **persona 的篇幅**：R6 要求 2000–4000 字。太短拦不住，太长吃上下文（每轮都进系统提示词）。
4. **要不要一开始就把 `docs/` 发布进 npm 包**：进了包会让体积变大，但不进包用户就没有安装文档。
