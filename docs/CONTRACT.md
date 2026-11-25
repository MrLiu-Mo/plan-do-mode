# CONTRACT.md：state.js 的精确契约

> 这份文件是给**实现者 AI** 读的：凡本文件写死的名字、字段、校验，实现必须逐字照做；
> 凡标了「契约补充」的，是 PLAN.md 没写死、这里补上决定的，改动前先问人。
> 目的：防止不同轮次的实现各造一套事件名/字段名，最后拼不起来。

## 1. 阶段（stage）枚举

```js
export const STAGES = [
  'inbox',    // 灵感已记，未立项
  'clarify',  // 澄清中
  'idea',     // 想法定稿，写 IDEA.md
  'tech',     // 技术拆解，写 TECH.md
  'decide',   // 选路：小验证 / 直接做 / 交接
  'verify',   // 时间盒小验证
  'build',    // 边做边学，逐卡推进
  'ship',     // 收尾验收
  'done',     // 终态：成了
  'handoff',  // 终态：交给 AI 做，人只验收
  'dropped',  // 终态：证伪或搁置
];
```

非终态集合：`inbox` / `clarify` / `idea` / `tech` / `decide` / `verify` / `build` / `ship`。
终态集合：`done` / `handoff` / `dropped`。
`paused` **不是阶段**，是任意非终态上的一个布尔标志。

> **`inbox` 是枚举里的「灵感态」，项目不会停留在这里**（实现决定，2026-11-25）：立项
> （`plando_idea action=pick`）直接从灵感库创建项目并把 stage 置为 `clarify`，
> `createInitialState()` 产出的初始 stage 就是 `clarify`。因此 `drop` 的 `from` 虽按「任意非终态」
> 字面包含 `inbox`，实际不会有项目以 `inbox` 身份进入状态机——这是**冗余而非矛盾**，实现按表格字面即可，
> 不要为它加特判。

每个阶段必须有一句中文标签（`STAGE_LABELS`）和一句「下一步该做什么」（`NEXT_ACTIONS[stage]`），
这两样会出现在 `plando_status` 和守卫的拒绝理由里。

### 1.1 `lib/state.js` 的导出清单（逐字照抄，测试会断言）

```js
export const SCHEMA_VERSION = 1;
export const STAGES;            // string[]，11 项，顺序同 §1
export const TERMINAL_STAGES;   // ['done','handoff','dropped']
export const STAGE_LABELS;      // { [stage]: 中文名 }
export const NEXT_ACTIONS;      // { [stage]: 一句话下一步 }
export const TRANSITIONS;       // { [event]: { from: string[], to: string } }
export function canTransition(state, event);                 // -> boolean
export function validatePayload(event, payload, config);     // -> { ok, reason? }
export function applyEvent(state, event, payload, config);   // -> { ok, state?, reason?, effects? }
export function computeSize(items, constraints);             // -> { size, sizeReason, totalMinutes }
export function checkBudget(items, budget);                  // -> { ok, reason? }
export function migrate(state);                              // -> { ok, state?, reason? }
export function inspectShape(state);                          // -> string[]，空数组表示 shape 可用
export function createInitialState(project);                 // -> state
```

`inspectShape` 是读取侧的形状体检：手改、老文件、迁移都可能带进 `null` / 非对象元素，
流到工具层就变成不可读的 `Cannot read properties of null`。`project.loadState` 在返回
`ok: true` 前会先跑一次，坏了就报错并指出字段路径，**不重置**（§4 同样的规矩）。
`migrate` 必须在返回前也让它通过——否则坏 state 会被洗白成当前版本并写回磁盘。

`effects` 是给调用方（tools.js）用的提示，取值固定为下面之一或省略：

```js
{ rerender: ['IDEA.md'|'TECH.md'|'VERIFY.md'|'HANDOFF.md'|'CHANGE-GUIDE.md'|'cards'],
  invalidateCards: string[],   // 被 revise 作废的卡 id
  terminal: 'done'|'handoff'|'dropped' }
```

`applyEvent` 不改传进来的 `state` 对象（不可变风格：返回新对象），也不写文件。

## 2. 事件表（唯一推进入口）

`plando_transition` 接受的事件，只有下表这些。**`pick` 不在其中**（见 §2.1）。

| event | 允许的 from | 推进到 | payload 必填 | 校验要点 |
|---|---|---|---|---|
| `clarify_done` | clarify | idea | `what, done, notDo, users, assumptions[], constraints{}, baseline{}` | 七个字段全非空；`assumptions` ≥1；`baseline` 三字段合法 |
| `idea_ok` | idea | tech | — | IDEA.md 已渲染且结构完整 |
| `tech_ok` | tech | decide | `items[]` | 每项 9 字段齐全；预算校验通过；算 `size` |
| `choose_verify` | decide | verify | `hypothesis, method, timeboxMin, judge` | `timeboxMin` 为 1–60 的整数 |
| `choose_build` | decide | build | `cards[]` | 卡片覆盖所有 TECH 项；`size=large` 且未做过验证 → 拒绝 |
| `choose_handoff` | decide | handoff | — | — |
| `verify_result` | verify | decide | `result, evidence` | `result ∈ {pass, fail, inconclusive}`；`evidence` 非空 |
| `cards_done` | build | ship | — | 所有卡 `status ∈ {done, downgraded}`，无 `todo/doing/stale`；**且至少一张是 `done`**（全卡降级 = 什么都没跑通，不是「小步跑通」） |
| `ship_pass` | ship | done | `offlineOk, selfChange, explain` | 三项都为真/非空 |
| `drop` | 任意非终态 | dropped | `reason` | `reason ∈ {falsified, parked}`；实际不会有 `inbox` 项目，见 §1 备注 |
| `revise` | idea / tech / decide / build | tech | `reason` | 非空；受影响卡标 `stale`；重渲染 IDEA.md |
| `pause` | 任意非终态 | 同阶段 | — | 置 `paused=true`。**语义是「守卫层提示先 resume」，不冻结状态机**——暂停期间仍可推进事件，`paused` 保持 `true` |
| `resume` | 任意非终态 | 同阶段 | — | 置 `paused=false`；未暂停时调它不算错，返回 `{ok:true, noop:true}` |
| `reopen` | done / handoff / dropped | decide | `reason` | 非空；清 `paused`、清 `terminal` |

非法转移的返回形状固定：

```js
{ ok: false, reason: 'plando：现在是「技术拆解」阶段，还不能选路——先把 TECH 清单补全。下一步：用 plando_transition 传 tech_ok。' }
```

### 2.1 `pick` 与 `drop` 的歧义（契约补充）

PLAN 里 `pick`/`drop` 同时出现在 `plando_idea` 的 action 和状态机的边上。这里切开：

| 说法 | 归属 | 含义 |
|---|---|---|
| `plando_idea(action=pick)` | 灵感库操作 | 把 `inbox` 里的一条灵感立项 → 项目进入 `clarify`。**唯一能离开 inbox 的方式。** |
| `plando_idea(action=park)` | 灵感库操作 | 灵感标「以后再说」，仍在灵感库里，不产生项目 |
| `plando_idea(action=drop)` | 灵感库操作 | 从灵感库删掉一条**未立项**的灵感，无终态 |
| `plando_transition(event=drop)` | 状态机 | 已立项项目放弃 → `dropped` 终态，必须带 `reason` |

实现要求：`plando_transition` 收到 `event=pick` 必须报错并提示「立项请用 `plando_idea action=pick`」。

## 3. payload 字段定义

### clarify_done

```js
{
  what: string,        // 一句话：这东西是什么
  done: string,        // 用户可观察的「做成了」现象，禁止写成「功能都实现了」
  notDo: string,       // 明确不做什么
  users: string,       // 谁用
  assumptions: string[], // 关键假设，≥1 条，必须可证伪
  constraints: {       // 约束
    budget?: string, platform?: string, tech?: string, promiseRisk?: boolean,
  },
  baseline: {          // 用户基线，决定 TECH 难度与预算
    experience: 'beginner' | 'some' | 'experienced',
    hoursPerWeek: number,   // 1–60
    goal: 'learn' | 'ship',
  },
}
```

`done` 的启发式校验（契约补充）：非空、≤200 字，且**不得**只由这些词构成：
`实现了 / 完成了 / 功能齐全 / 都做完了`。命中时返回 `ok:false`，理由要求改成可观察现象
（能点开、能输入、能导出、能看到结果……）。

### tech_ok / items[]

```js
{
  id: string,          // t1, t2, ... 由实现分配，稳定不复用
  title: string,       // 技术项名
  why: string,         // 为什么需要
  ifMissing: string,   // 不会怎样错 / 影响哪个判断
  owner: 'user' | 'follow' | 'ai',
  difficulty: 1 | 2 | 3,
  minutes: number,     // 预计分钟，正整数
  judge: string,       // 过关判据（可判定）
  file: string,        // 落在哪个文件
}
```

预算校验（来自 `config.budget`，默认 `{ mustUnderstand: 5, totalMinutes: 600 }`）：

- `items.filter(i => i.owner === 'user').length <= budget.mustUnderstand`
- `sum(items.minutes) <= budget.totalMinutes`
- 超了返回 `ok:false`，理由里必须给出「超了多少 / 怎么降级」两个数字。
- 分钟数以**数字**参与计算：字符串 `'30'` 按 30 算（`minutesOf` 统一归一），
  缺省 / 非正 / 非数字按 0 算。三处（`checkBudget` / `computeSize` / `TECH.md` 渲染）必须同口径。
- `choose_build` 会再跑一次预算校验：`tech_ok` 的校验被绕过时（存量 v0 迁移、手改 state）
  这里就是最后一道门。

规模判定：

```js
size = (totalMinutes > 180 || constraints.promiseRisk === true) ? 'large' : 'small'
sizeReason = totalMinutes > 180 ? `预计 ${totalMinutes} 分钟` : (promiseRisk ? '承诺风险' : '')
```

### choose_verify / choose_build / verify_result / ship_pass

```js
// choose_verify
{ hypothesis: string, method: string, timeboxMin: 1..60, judge: string }

// choose_build
{ cards: [{ techIds: string[], title: string }] }   // 允许一张卡覆盖多个 TECH 项

// verify_result
{ result: 'pass'|'fail'|'inconclusive', evidence: string }

// ship_pass
{ offlineOk: boolean, selfChange: boolean, explain: string }
```

`verify_result` 之后**必须回 decide**（不直接进 build）；`size=large` 时 `decide` 的推荐必须是 `verify`。

## 4. state.json 形状（schemaVersion 1）

```js
{
  schemaVersion: 1,
  projectId: 'proj_<8位>',
  name: string,
  dir: string,                 // 项目绝对路径
  createdAt: ISO, updatedAt: ISO,
  stage: STAGES[number],
  paused: false,
  budget: { mustUnderstand: 5, totalMinutes: 600 },  // 快照：由 createInitialState 从 config.budget 写入
  idea: { id, title, oneLine, users, mvp: string[], acceptance: string[], notDo: string[], assumptions: string[], constraints: object },
  baseline: { experience, hoursPerWeek, goal },
  clarify: { rounds: number, answers: object[], open: string[] },
  tech: { items: TechItem[], size: 'small'|'large', sizeReason: string },
  decision: { choice: 'verify'|'build'|'handoff'|null, history: [{choice, at}] },
  verify: { hypothesis, method, timeboxMin, judge, result, evidence, overtime: boolean },
  cards: Card[],
  ship: { offlineOk, selfChange, explain },
  terminal: { kind: 'done'|'handoff'|'dropped', reason: string, at: ISO } | null,
}
```

**`budget` 是 state 快照**（契约补充）：`config.budget` 只在创建项目时读一次，写进 `state.budget`；
之后所有渲染与校验都读 `state.budget`，这样产物不会因为用户改配置而前后不一致。
`terminal.reason` 在 `ship_pass` / `choose_handoff` 这类没有 reason payload 的事件里写 `''`。

```js
// Card
{ id: 'c1', techIds: ['t1'], title: string,
  status: 'todo'|'doing'|'done'|'downgraded'|'stale',
  learn: { note: string, at: ISO } | null,
  do:    { files: string[], at: ISO } | null,
  verify:{ output: string, exitCode: number, at: ISO } | null,
  evidence: { kind: 'check'|'files', summary: string, at: ISO } | null,
  startedAt: ISO|null, doneAt: ISO|null }
```

**写盘规则**：先写 `state.json.tmp`，再 `fs.renameSync` 覆盖——多会话共享同一份 state，
半写文件比报错更糟。

**证据要对账**：`evidence.summary` 是**自述**，「跑了 npm test，退出码 0」这句话
在从没跑过的时候一样写得出来。所以 `plando_card action=done` 时对三类证据分别核对：

- **前置闸（所有证据都过）**：项目里必须**至少有一个用户自己的产出**。
  `node --test` 在一个测试文件都没有的项目里退出码是 **0**，这条闸专治
  「declare → run → done 三步收掉一张卡而一个字都没写」。
  「用户自己的产出」= 项目里的普通文件，**排除**模式产物（`IDEA.md` / `TECH.md` / …）
  与脚手架能写的 7 个配置文件（`package.json` 等）——那两类都可能是插件/AI 自己造的，
  拿它们当「我干完了」的证据是自我认证。
- `kind='check'`：每次 `plando_check` 的结果记在 `<projectDir>/.plando/last-check.json`
  （`{ name, command, ok, exitCode, at }`，**不进** `state.json`：它属于运行记录，不是状态机数据，
  不参与版本迁移），必须存在 `lastCheck.name === card.id && lastCheck.ok === true` 的记录，否则拒。
- `kind='files'`：证据（或卡片的 `do.files`）里点名的文件必须**真的在**上面那份用户产出清单里。
  点不出真实文件名就拒。

纯函数 `doneCard(state, id, evidence, options)` 只在 `options` 里**有那个键**时才强制
（`lastCheck` / `projectFiles`），`tools.js` 每次都会传，所以插件运行时对账一定生效。

**降级理由也要能核对**：`downgrade` 的理由必须交代「降级后实际交付到哪一步」。
判据是「删掉空话词后还剩 ≥6 个实质字符，或出现可指认的标记（文件名 / 数字 / 拉丁词）」——
`'x'` / `'我懂了'` / `'时间不够'` 这类没有具体对象的一律拒（`'时间不够，只跑通 demo'` 可以）。
全卡都降级时 `cards_done` 会拒（见 §2 事件表）。

**id 字符集（硬约束）**：`cards[].id` 与 `tech.items[].id` 必须匹配 `^[A-Za-z0-9_-]{1,40}$`。
原因不是洁癖：卡 id 会被当成文件名渲染成 `.plando/cards/<id>.md`，而 `../../README` 这种 id
`path.join` 之后仍然落在项目目录内，`writeText` 的边界断言拦不住，用户自己的文件会被覆盖。
新写入路径（`tech_ok` / `choose_build`）直接拒绝不合规 id；`migrate()` 遇到存量坏 id 会
按位置重编号（`c1`、`t1`……）并写进 `state.repairs`，同时改掉卡片上的 `techIds` 引用。
`techIds` 引用的必须是 `tech.items` 里真实存在的 id，且每张卡至少覆盖一项。

**版本**：解析失败、`schemaVersion` 缺失、非整数、或高于当前 `SCHEMA_VERSION` → 报错停止，**绝不重置**。
已知旧版本目前只有 `0`（视为「早期内部草稿」）：`migrate()` 补齐缺失字段、不覆盖已有值后升到 1。
将来出现 v2 时改 `SCHEMA_VERSION` 并加升级分支。

## 5. 错误消息规范

所有面向模型的错误都遵守同一形状（测试会断言前缀）：

```
plando：<现在在哪>，<为什么不行>——<下一步做什么>
```

- 中文、一句话、不用 emoji、不超过 160 字。
- 必须包含**下一步的具体动作**（调哪个工具、传哪个 event）。
- 非法转移同时写一条 `log.jsonl`：`{at, kind:'reject', event, from, reason}`。
- **分层约定（契约补充）**：`validatePayload(event, payload, config)` 拿不到 state，
  所以它的 reason 里**不含**「现在是哪个阶段」；只在 `applyEvent` 里由调用方用阶段名包装一次。
  测试断言 `validatePayload` 的 reason 时，只断言 `plando：` 前缀与「下一步：」两部分。

## 6. 产物渲染契约

产物一律**由 state 渲染**，不允许 AI 手写。渲染函数是纯函数：`(state) => string`。

`IDEA.md` 固定 8 节，标题逐字一致：

```
# <name>
## 一句话
## 谁用
## 做什么（MVP）
## 怎么算成
## 什么不做
## 关键假设
## 约束
## 用户基线
```

`TECH.md` 固定 9 列表格，列名逐字一致：

```
| id | 技术项 | 为什么需要 | 不会怎样错 | 归属 | 难度 | 分钟 | 过关判据 | 文件 |
```

**TECH.md 的既定形态**（契约补充）：一级标题为 `# <name> 技术拆解`；按 owner 分三组
（`user` → `follow` → `ai`），**每组各带一份逐字 9 列表头**——Markdown 分组表格必须各有表头。
`checkTechStructure` 只要求表头**至少出现一次**，不重复计数。

**`renderTech` 的预算来源**（契约补充）：`renderTech(state, options?)` 的读取顺序固定为
`options.budget` → `state.budget` → 契约默认 `{5, 600}`。其中 `options.budget` **只作测试或显式覆盖**，
生产路径读 `state.budget`。

`HANDOFF.md`、`CHANGE-GUIDE.md`、卡片正文 `<项目>/.plando/cards/<id>.md` 的结构由 `artifacts.js` 自己定，
但必须满足：卡片正文含「学 / 做 / 验」三段小标题，且每段都有可执行判据。

## 7. 本契约的边界

- 不规定文件名以外的实现细节（怎么分函数、怎么命名内部变量随意）。
- 不规定日志格式以外的持久化方式（`log.jsonl` 追加写即可）。
- 上述枚举/字段名/事件名/错误前缀是**跨轮次接口**，任何改动都要同步改测试和 PLAN.md。
