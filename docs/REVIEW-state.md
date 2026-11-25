# lib/state.js 对抗性审查（红队报告）

- 审查对象：`lib/state.js`（631 行，工作树当前版本；同批相关文件 `lib/cards.js` / `lib/tools.js` 只在定位根因时引用，不在审查范围内）
- 判决依据：`docs/CONTRACT.md`（§1 导出面 / §2 事件表 / §3 payload / §4 state 形状 / §5 错误消息）；冲突时以契约为准
- 方法：不读测试断言什么，只找**测试没断言到**的路径；每条结论都跑过真实代码（`node` 直接 import `lib/*.js`，关键项经 `tools.js` 走完整「加载 → 推进 → 落盘 → 重渲染」路径，用的都是真文件）
- **本报告未改动任何源文件**。`lib/state.js` 不在我的写作用域，我只输出结论。
- 篇幅约定：高危项给最小复现 + 真实输出；中危项给可复现调用；观察项只记结论。全部带 `文件:行` 定位，行号已逐条核对。

复现脚本在临时目录（`%TEMP%\probe*.mjs`），仓库内不留文件；下面给出的调用都可以直接粘进 `node --input-type=module` 跑。

---

## 0. 结论速览

| # | 问题 | 严重度 | 能否从正常流程触发 |
|---|---|---|---|
| F1 | `migrate` 放行非法 v0，坏字段被永久写回 v1，之后工具抛原始 `TypeError` | **高**（后果不可逆） | 需 v0 草稿 |
| F2 | `state.budget` 是字符串数字时预算门**静默失效** | **高**（后果不可逆） | 需 v0 草稿 |
| F3 | `choose_build` 允许重复卡 id → 卡片永久死锁，且卡 md 互相覆盖 | **高** | **是（模型漏写 id 即触发）** |
| F4 | `revise` 后复用旧 `verify.result`，绕过「large 必须先验证」 | **高** | **是（正常 revise 流程）** |
| F5 | 卡 id 未净化 → `path.join` 路径穿越，**可覆盖项目内任意文件、写到项目目录外** | **高** | **是（模型给任意 id）** |
| F6 | `tech_ok` 允许重复 tech id → 覆盖校验被 `Set` 骗过 | 中 | 是 |
| F7 | `reason()` 上界是 **161** 不是 160（`'plando：'.length === 7` 却减 6） | 中 | 是 |
| F8 | `choose_build` 的「下一步：回 tech 传 tech_ok」从 decide **不可达** | 中 | 是（reopen 到 decide 的项目） |
| F9 | 零宽字符（U+200B 等）绕过「非空」与「done 必须可观察」 | 中 | 是 |
| F10 | v1 state **完全不做字段类型校验**，数组里的 `null` 让工具抛原始 JS 错误 | 中 | 是（v1 文件被手改/迁移留下） |
| F11 | `migrate` 不补 `tech.size` → v0 大项目绕过 large 门 | 中 | 是 |
| F12 | `NEXT_ACTIONS.decide` 是常量，做不到契约「size=large 时推荐必须是 verify」 | 低 | 一直是 |
| F13 | `paused` 非布尔值时被一致当成「未暂停」（fail-open），`resume` 也清不掉 | 低 | 是（迁移残留） |
| F14 | `revise` 不清 `verify`，`VERIFY.md` 残留上一版假设 | 低 | 是 |
| F15 | `drop` 的 `terminal` 被写两次（不影响结果） | 观察 | — |

**否定结论（查过，不是 bug，列出来免得别人再花时间）**：见 §3。

### 可达性说明（避免把「理论上」写成「很可能」）

我要说清楚哪些是「正常使用就会碰到」、哪些是「需要坏数据」。这影响发布判决的权重：

| 项 | 触发前提 | 现实概率 |
|---|---|---|
| F3 / F4 / F5 | 只需模型给出 payload，不需要任何坏数据 | **高**——模型漏写一个 `id`、或 `revise` 一次就会碰到 |
| F8 / F12 / F14 | 正常流程（reopen 到 decide / 看 status / revise） | **高** |
| F7 / F9 | 模型给出超长字段或含零宽字符的字符串 | 中——F7 要长 payload，F9 要模型抄到不可见字符 |
| F1 / F2 / F10 / F11 / F13 | 需要磁盘上存在坏 state：要么是 v0 草稿，要么被手改过 | **低**（但一旦发生就是不可逆的，见 F1 的「写回洗白」） |

`createInitialState` 走的是 `resolveBudget`，`config.js` 又把 budget 校验成正整数，所以**从「新建项目」这条路进不来字符串预算**。F2 的唯一入口是 v0 迁移或手改 `state.json`。我没有把它写成「用户改配置就会中招」——那是假的。它之所以还是「高」，理由是**后果不可逆 + 报错不可读**：v0 一旦被 `migrate` 写成 v1，就再也没有升级机会了。

考虑 v0.1.0 是首个发布版、理论上还没有真正的 v0 存量项目，可以争辩 F1/F2 只是「为未来留的坑」。但契约 §4 明确把 v0 定义为「已知旧版本」，说明设计上就承认会读到 v0；既然会读，就得读对。

---

## 1. 高危

### F1　`migrate` 放行坏 v0 → 坏字段被写回 v1，工具开始抛原始 JS 错误

`upgradeFromV0` 只修 7 个字段的**容器类型**（`idea/clarify/tech/decision/verify/baseline/ship` 是否为普通对象、`cards` 是否为数组、`stage` 是否在枚举里），**不校验这些容器里的元素**，也不修 `budget / terminal / paused / projectId`。

最小复现（纯函数，两条语句）：

```js
import { migrate, applyEvent } from './lib/state.js';
const m = migrate({ schemaVersion: 0, name: 'x', dir: 'D:\\p', stage: 'decide',
                    tech: { items: 'not-array' } });
// m.ok === true
// m.state.tech === { items: 'not-array' }        ← 连 size / sizeReason 都没有（见 F11）
applyEvent(m.state, 'choose_build', { cards: [{ techIds: ['t1'], title: 'a' }] }, {});
// 抛 TypeError: (items || []).map is not a function
```

`cards` 里的元素坏掉也一路通行：

```js
migrate({ schemaVersion: 0, cards: [null] }).state.cards   // -> [null]
applyEvent({ ...s, stage: 'build', cards: [null] }, 'cards_done', {}, {});
// 抛 TypeError: Cannot read properties of null (reading 'status')
```

**最坏情况（你点名要问的）**：会。真实路径上它不只是「返回一个字段坏掉的 state」，而是**先把坏 state 当成合法 v1 写回磁盘**，之后每次读都走 v1 分支、不再尝试修复：

```
project.loadState(dir)         // 读到 schemaVersion:0 → migrate → atomicWriteJson → migrated: true
JSON.parse(state.json).schemaVersion  // 已经是 1
plando_transition(choose_build)       // plando：(items || []).map is not a function——下一步：先调 plando_status…
```

实测输出（真文件）：

```
choose_build -> plando：(items || []).map is not a function——下一步：先调 plando_status 确认阶段与项目路径，再按参数说明重试
磁盘已被写回 v1: 1
plando_status -> · 项目：老草稿（…） / · 阶段：选路（decide） / · 下一步：传 choose_verify / choose_build / choose_handoff 选一条路
```

两个叠加的问题：

1. **报错文本把原始 JS 异常直接丢给模型**（`tools.js` 的 `run()` 兜底），违反 CONTRACT §5 的「plando：<现在在哪>，<为什么不行>——下一步：…」形状——这里「为什么不行」是不可读的引擎消息，模型拿到也不知道该改哪个字段。
2. **`plando_status` 看起来一切正常**，模型没有任何线索知道 `tech.items` 是字符串，只能反复试错。

期望：`migrate` 在返回 `ok:true` 前要么把容器内容也修好（`items` 非数组→`[]`，元素非对象→丢弃），要么返回 `ok:false` + 人工修回的指引。CONTRACT §4 只说「已知旧版本 → migrate 升版后写回」，但「写回一个无法使用的 state」比「报错停止」更糟，因为报错还能救，写回后 `schemaVersion` 变了，升级分支再也不会执行。

同样被放行的坏值（实测全部 `migrate.ok === true` 且原样保留）：`stage: 'garbage'`（被静默重置成 `clarify`，不报错）、`budget: 'garbage'`、`budget: { mustUnderstand: '5' }`、`terminal: 'string'`、`paused: 'yes'`、`projectId: 123`。

---

### F2　`state.budget` 是字符串数字时，预算门**静默失效**

`checkBudget` 用 `Number.isFinite(b.mustUnderstand)` 判「这条规则要不要执行」：

```js
if (Number.isFinite(b.mustUnderstand) && userCount > b.mustUnderstand) { … }
if (Number.isFinite(b.totalMinutes) && totalMinutes > b.totalMinutes) { … }
```

`Number.isFinite('5') === false` → 两条规则**同时跳过**，`checkBudget` 返回 `{ ok: true }`。而 `effectiveConfig` 会把 `state.budget` 原样当 `config.budget` 用，所以只要 state 里的预算是字符串，预算这条硬约束就彻底消失。

端到端复现（真文件 + 真工具，不是直接调 `applyEvent`）：

```js
// .plando/state.json（v0）
{ schemaVersion: 0, stage: 'tech',
  budget: { mustUnderstand: '5', totalMinutes: '600' }, … }
```

```
plando_status 首行 -> · 阶段：技术拆解（tech）
plando_transition(tech_ok, 50 条 owner:user × 99999 分钟)
  -> 已推进：tech → decide（tech_ok）
落盘 size = large   总分钟 = 4999950   user 条数 = 50
磁盘 budget 仍是 = {"mustUnderstand":"5","totalMinutes":"600"}
```

契约 §3 的两条硬上限（`user` 项 ≤ `mustUnderstand`、总分钟 ≤ `totalMinutes`）**一条都没生效**：50 条 user 项（上限 5）、4999950 分钟（上限 600）。

对照实验（说明这确实是 `Number.isFinite` 的锅，不是预算整体失效）：

```
budget={"mustUnderstand":5,"totalMinutes":600}      -> 拒绝（预算生效）
budget="garbage"                                    -> 拒绝（预算生效，退回默认值）
budget=null                                         -> 拒绝（预算生效）
budget={"mustUnderstand":"5","totalMinutes":"600"}  -> PASS（预算失效）  ← 只有「字符串数字」能穿过去
```

期望：`resolveBudget` 已经在 `createInitialState` 里做了「只取正整数、否则用默认值」，但 `upgradeFromV0` 直接 `{...defaults, ...clone(state)}`，把 `state.budget` 原样盖上去，绕过 `resolveBudget`。修法很小：`upgradeFromV0` 里补一行 `merged.budget = resolveBudget(merged.budget)`（同理 `paused = merged.paused === true`、`terminal` 校验 kind）。

---

### F3　重复卡 id → 卡片**永久死锁**，且卡 md 互相覆盖

`choose_build` 不校验 card id 唯一性；`applyEvent` 只在缺 id 时按序号补 `c1/c2`，**不查重**。三处「自动 id 撞显式 id」的路径都能造出同名卡：

```js
// 1) 两张卡都显式给同一个 id
applyEvent(state, 'choose_build', { cards: [
  { id: 'c1', techIds: ['t1'], title: 'A' },
  { id: 'c1', techIds: ['t2'], title: 'B' },
] }, cfg).state.cards.map(c => c.id)     // -> ['c1', 'c1']

// 2) 第一张不给 id（自动补 c1），第二张显式 c1
// 3) tech_ok 同理：第一项不给 id 自动 t1，第二项显式 t1 -> ['t1','t1']
```

死锁全过程（`lib/cards.js` 的 `indexOfCard` 是 `findIndex(c => c.id === id)`，永远只命中第一张）：

```
choose_build().ok / cards => true / c1,c1
startCard(built,'c1') + doneCard(...,'c1')
  => c1:A:done | c1:B:todo
applyEvent(cards_done) => plando：现在是「边做边学」阶段，还有 1 张卡没收尾（c1）——下一步：先用 plando_card done 或 downgrade 收尾，再传 cards_done
```

然后**卡 B 没有任何 API 能碰到**，而且系统给出的提示是自相矛盾的：

```
doneCard 的提示       -> …先 start 这张卡，做完再 done
照提示 startCard(c1)  -> plando：…卡片 c1 现在是 done，不能重新开工——下一步：已 done 的卡不用重开…
downgradeCard(c1)     -> plando：…卡片 c1 已经是 done，不能再降级…
```

唯一的逃生口是 `revise`（会把两张都标 `stale`）或 `drop → reopen`，但两条都不在错误信息里，模型照提示操作只会原地转圈。

附带损害：`renderArtifacts` 用 `path.join('.plando','cards',`${card.id}.md`)` 落盘，同名卡只有最后一个能留下：

```
c1.md 首行 = # 卡B
含「卡A」= false  含「卡B」= true
cards 目录文件数 = 1（2 张卡只落 1 个文件）
```

第一个卡的内容**直接丢失**，而 state 里仍记着两张。

期望：`validateChooseBuild` / `validateTechOk` 里加一行 id 唯一性检查，报错带上重复的 id 和「换一个 id 或删掉重复项」。这是最便宜的修法。

---

### F4　`revise` 后复用旧 `verify.result`，绕过「large 必须先验证」

契约 §2 要求 `choose_build` 时「`size=large` 且未做过验证 → 拒绝」，实现是 `draft.tech.size === 'large' && !hasVerified(draft)`，而 `hasVerified` 只看 `RESULTS.includes(state.verify.result)`——**不区分这次验证是不是针对当前这份技术清单做的**。

`revise` 不重置 `verify`（只清 `terminal/paused` 的 `reopen` 也不清），于是：

```
tech_ok(10 分钟)            -> size=small
choose_verify + verify_result(pass)   -> verify.result='pass'
choose_build                -> 进 build
revise('范围扩大')           -> 回 tech，verify.result 仍是 'pass'
tech_ok(500 分钟)           -> size=large（>180）
choose_build                -> **通过**，stage=build     ← 契约要求拒绝
```

端到端实测（真文件、真工具）：

```
revise 后 tech.size = large  verify.result = pass
VERIFY.md 还在吗 = true  内容首行 = ## 要验证的假设
large + 旧验证 → choose_build -> 已推进：decide → build（choose_build）
```

即：用户改了方向、把工作量从 10 分钟扩到 500 分钟，插件仍然认为「验证过了」，推荐直接开工。这是 PLAN 里「先验证再投入」那条原则的直接漏洞。

期望：`revise` 时清 `verify`（`result: null, evidence: '', overtime: false`），或给 `verify` 加一个 `forTechSize` / `forItemsHash` 快照让 `hasVerified` 能比对。前者更简单也更符合「revise = 假设变了」。

---

### F5　卡 id 未净化 → 路径穿越，可覆盖项目内任意文件 / 写到项目目录外

`tools.js` 的 `renderArtifacts`：

```js
const rel = path.join('.plando', 'cards', `${card.id}.md`);
written.push(writeText(dir, rel, papers.renderCard(state, card)));
```

`writeText` 直接 `path.join(path.resolve(dir), rel)` 再 `fs.writeFileSync`，不做任何 `resolve` 后的边界检查。`card.id` 完全由模型通过 `choose_build` 的 payload 控制。

复现 1 —— 覆盖项目内的真实产物：

```js
plando_transition({ event: 'choose_build',
  payload: { cards: [{ id: '../../IDEA', techIds: ['t1'], title: '恶意标题' }] } })
// -> 已推进：decide → build（choose_build）
// IDEA.md 现在 =
// # 恶意标题
// - 卡 id：../../IDEA
// - 覆盖 TECH 项：t1（x）
```

复现 2 —— 写出项目目录：

```
id=../../../逃逸出项目 -> 已推进：decide → build（choose_build）
父目录 = [ 'proj', '逃逸出项目.md' ]      ← 文件落在项目目录之外
```

`fs.mkdirSync(path.dirname(file), { recursive: true })` 还会顺手把中间目录建出来。

期望：`card.id` 在 `validateChooseBuild` 里限制成 `^[A-Za-z0-9_-]{1,40}$`（或至少拒绝 `.` / `/` / `\` 与路径分隔符），并且在 `writeText` 里加一道「`path.resolve(file)` 必须以 `path.resolve(dir) + path.sep` 开头」的断言。现在这道防线是零——`lib/state.js` 一侧和 `lib/tools.js` 一侧都没有。

> 说明：这不是「模型会故意的」问题，而是「模型抄错/编一个 id」就会触发。`plando_project` 的 `dir` 参数同样是用户给什么就用什么（`path.resolve` 后直接用），但那是设计上就该由用户指定的路径，属于另一个话题（是否需要限制在 `dataRoot` 下），不在本报告范围内。

---

## 2. 中危及以下

### F6　重复 tech id 让覆盖校验被骗过

`uncoveredTechIds` 用 `Set` 收集已覆盖 id，重复的 tech id 只算一个名字：

```js
tech_ok({ items: [item('t1'), item('t1', { title: '重名' })] })   // ok: true，ids -> ['t1','t1']
TECH.md 里 id=t1 的行数 = 2（同一 id 出现多行）
choose_build({ cards: [{ techIds: ['t1'], title: '只覆盖一个' }] })  // -> 通过
```

两张技术项实际只被一张卡覆盖，但校验认为完整。`TECH.md` 会出现两行同名 id，模型照表格逐项核对时会数出 2 项、卡片只对应 1 项。定级「中」而不是「高」：它不会死锁也不会丢文件，只是让「覆盖校验」这道门在特定输入下失去意义；而 F3 的重复**卡** id 有真实死锁后果，所以两条分开记。

### F7　`reason()` 上界是 161 不是 160（off-by-one）

```js
const budget = 160 - 6 /* plando： */ - [...head].length - [...tail].length;
```

`'plando：'` 实际是 **7** 个字符（`p l a n d o` 六字母 + 全角冒号 `U+FF1A` 一个），公式里只减了 `6`：

```
"plando：" -> length 7, codepoints 7
p U+70 / l U+6C / a U+61 / n U+6E / d U+64 / o U+6F / ：U+FF1A
```

所以 why 字段的可用额度多了 1，最终拼出 161：

```js
// 代码允许 why 填到 budget 个字符，拼出来正好 161
const total = `plando：${head}${'x'.repeat(budget)}${tail}`;
[...total].length  // -> 161
```

真实路径（不是构造）：

```
choose_build 缺 40 个技术项        -> 161 字  **超限**
plando_card 传 200 字 id           -> 161 字  **超限**
cards.startCard / doneCard / setLearn 传超长 id -> 161 字
migrate 传超长 schemaVersion 字符串 -> 161 字
```

`lib/cards.js` 的 `reason()` 里是**同一个 `- 6`**，同一个 bug 复制了一份。

注意区分：`lib/policy.js` 有自己的一份 `truncate()`，那份是对的（`policy.test.js:214` 专门用超长 label+nextAction 测过截断）。**有 bug 的是 `state.js:86` 和 `cards.js:22` 这两份 `reason()`**，而 `state.payload.test.js:14` 的 `assertReasonShape` 里所有用例的 why 都很短（最长的也就「第 N 个技术项的分钟数必须是正整数」），根本走不到截断分支，所以这个 161 一直是绿的。同理 `state.budget.test.js` 里那些 reason 也全都短。

修法：`- 7`，或干脆把 `'plando：'.length` 写成常量表达式别硬编码。建议 `state.js` / `cards.js` 共用同一个 reason 构造器，别再各写一份。

### F8　`choose_build` 的「下一步」从 decide 不可达

```js
// state.js:437
return { ok: false, reason: reason('现在是「选路」阶段', '还没有技术项清单', '先把手头做完，回 tech 传 tech_ok') };
```

从 `decide` 走到这条分支的真实路径：`clarify → drop → reopen`（`reopen` 的 `to` 是 `decide`，而 `tech.items` 从没填过）。实测：

```
reopen 后 stage = decide  tech.items = []
choose_build  -> plando：现在是「选路」阶段，还没有技术项清单——下一步：先把手头做完，回 tech 传 tech_ok
照提示 tech_ok -> plando：现在是「选路」阶段，还不在技术拆解阶段——下一步：用 plando_transition 传 choose_verify / choose_build / choose_handoff 推进
实际可行的一跳 revise -> ok，stage=tech
```

`TRANSITIONS` 里 `from` 含 `decide` 且 `to === 'tech'` 的只有 `revise`，而提示里没提它。模型会照着提示在 decide 里反复试 `tech_ok`，每次都收一条「还不能执行」+ 一条把它推回 decide 的提示。逃生口是 `revise`（也可以用 `choose_handoff` 绕过去），但都要模型自己猜。

修法：提示改成「先传 revise（带 reason）回 tech 补技术项，再 tech_ok」，或允许 `decide → tech` 走 `tech_ok`。

### F9　零宽字符绕过「非空」与「done 必须可观察」

`isNonEmptyString` 用 `v.trim()`，而 `trim()` 只剥 WhiteSpace/LineTerminator；`U+200B/200C/200D/2060/180E/3164/115F` 都不是：

```
U+200B ZWSP          trim 后长度=1 **绕过 trim**
U+200C ZWNJ          trim 后长度=1 **绕过 trim**
U+200D ZWJ           trim 后长度=1 **绕过 trim**
U+2060 WJ            trim 后长度=1 **绕过 trim**
U+FEFF BOM           trim 后长度=0 （被 trim 掉）
U+3000 全角空格        trim 后长度=0 （被 trim 掉）  ← 这条是干净的
```

`clarify_done` 七个字段全填 `U+200B` **全部通过**：

```js
validatePayload('clarify_done', { what: '\u200B', done: '\u200B', notDo: '\u200B', users: '\u200B',
  assumptions: ['\u200B'], constraints: {}, baseline: {…} }, cfg)
// -> { ok: true }
applyEvent(...)  // -> ok:true，idea.oneLine 码点 = [8203]
```

连带 `checkDoneObservable` 也失效：它先 `replace(/[\s，。、,.!！?？;；:：]/g,'')` 再删空话词，`U+200B` 不在那个字符集里，所以

```
done="功能都实现了"      -> 拒绝（正确）
done="功能都实现了\u200B" -> 通过（空话词被删完，剩下的 ZWSP 让 rest.length !== 0）
```

期望：`isNonEmptyString` 改成 `v.replace(/[\s\u200B-\u200D\u2060\uFEFF\u180E\u3164]/gu, '').length > 0`，或 `checkDoneObservable` 先剥零宽再判。这是「形式合规、内容为空」的典型绕过，模型不知道要避开它，但一旦踩到产物里就是空白章节。

### F10　v1 state 完全不做字段类型校验

`loadState` 对 `version === SCHEMA_VERSION` 直接 `{ ok: true, state: parsed }`（`project.js:137`），不校验任何字段。数组里混进 `null` 会让工具层抛原始错误：

```
[cards:[null]]       plando_card -> plando：Cannot read properties of null (reading 'id')——下一步：先调 plando_status…
                     plando_transition(cards_done) -> plando：Cannot read properties of null (reading 'status')…
[tech.items:[null]]  plando_transition(choose_build) -> plando：Cannot read properties of null (reading 'id')…
```

`plando_status` 依旧显示一切正常（`cards.cardProgress` 会把非数组降级成 `total: 0`）。这条和 F1 是同一个根因的不同表现面：**读取侧不做形状校验，只在写入侧（validatePayload）做**，而迁移/手改/老文件都绕过写入侧。

期望：`loadState` 在返回前跑一次「形状体检」（至少 `cards` 每项非 null、`tech.items` 每项非 null、`budget` 是对象），坏了就报错并指出字段路径，别让它流到工具层变成 `TypeError`。

### F11　`migrate` 不补 `tech.size` → v0 大项目绕过 large 门

`upgradeFromV0` 只在 `merged.tech` 不是普通对象时整块替换成默认值；**是对象但缺 `size` 时原样保留**：

```
v0: { stage:'decide', tech: { items: [500 分钟的一项] } }
迁移后 tech = {"items":[{…, minutes: 500}]}      ← 没有 size / sizeReason
choose_build -> **PASS**（large-verify 门被跳过）
computeSize 重算应为: {"size":"large","sizeReason":"预计 500 分钟","totalMinutes":500}
```

`state.js:449` 的判据是 `draft.tech.size === 'large'`，`undefined` 直接短路成 false。同时 `TECH.md` 也**整行不写规模**（`artifacts.js:317` 的 `if (size === 'small' || size === 'large')` 同样跳过），实测：

```
## 预算汇总

- user 项 0 条 / 总计 500 分钟 / 预算 5 条 / 600 分钟
                                          ← 「规模」这一行整行不见了
```

模型只看到「总计 500 分钟」，没有任何「这是大项目」的信号，于是照着决定直接 `choose_build`。

修法：`upgradeFromV0` 里 `if (!['small','large'].includes(merged.tech.size)) merged.tech = { ...merged.tech, ...computeSize(merged.tech.items, merged.idea.constraints) }`。

### F12　`NEXT_ACTIONS.decide` 做不到契约 §3「large 时必须推荐 verify」

CONTRACT §3 line 177 原文：「`size=large` 时 `decide` 的推荐必须是 `verify`」。实现是常量表：

```
NEXT_ACTIONS.decide = '传 choose_verify / choose_build / choose_handoff 选一条路'
```

对 `size=large` 且未验证的项目，`plando_status` 输出同样是这句三选一：

```
· 阶段：选路（decide）
· 下一步：传 choose_verify / choose_build / choose_handoff 选一条路
```

`applyEvent` 的 `choose_build` 分支确实会拦（除了 F4 那条绕过），但**展示侧**没做到契约要求，模型看到的推荐和硬约束不一致。要么改契约（承认推荐是通用的），要么让 `format.js` 在 decide 且 `tech.size==='large'` 且未验证时换成 `'先传 choose_verify 做一次小验证'`。这是契约与实现的确定性冲突，按「以契约为准」的规矩，算实现的缺口；但因为已经有硬拦截兜底，记低。

### F13　`paused` 非布尔值时被**一致地当成「未暂停」**（fail-open），且 `resume` 无法把它清掉

`upgradeFromV0` 不归一化 `paused`，`paused: 'yes'` 会原样留在 v1 里。三处读法其实**一致**（都以 `=== true` 为准，`index.js:60` 归一化后传给 `policy`，所以 `policy.js:176` 拿到的一定是布尔）：

```
index.js 的 ctx.paused = false        （'yes' !== true）
policy 提示含「已暂停」= false
format 提示含「已暂停」= false
applyEvent('resume')  -> {"ok":true,"noop":true}     ← 清不掉
applyEvent('pause')   -> paused 变成 true            （这一步才会归一化）
```

所以不是「三处三个答案」（我第一版判断错了，已修正），而是**三处一致地 fail-open**：一个实际上处于暂停状态的项目，守卫不会因为暂停而拦写工具。严重度低（要求 state 被手改成非布尔值），但既然是「迁就坏数据」的方向，修法照旧——`upgradeFromV0` 里 `merged.paused = merged.paused === true`。

顺带记录一个真实的**行为空档**（不是 bug，但契约没写）：`paused=true` 时状态机**照样允许推进**，`clarify_done` 能过，且 `paused` 保持 `true`。契约 §2 对 `pause` 只写「置 `paused=true`」，没规定暂停后是否禁推进。如果本意是「暂停 = 冻结」，现在没有实现；如果本意只是「守卫层提示先 resume」，那没问题。建议在契约里写明，免得下一轮实现者按另一个意思改。

### F14　`revise` 不清 `verify`，`VERIFY.md` 残留上一版假设

```
revise 前 verify = {"hypothesis":"用户愿意每天记账",…,"result":"pass"}
revise 后 verify = 完全相同
revise 的 effects = {"rerender":["IDEA.md","CHANGE-GUIDE.md"],"invalidateCards":[]}   ← 没有 VERIFY.md
```

`tools.js:301` 的重渲染判据是 `state.verify.hypothesis` 非空，而 `verify` 没被清，所以：

```
VERIFY.md 还在吗 = true   内容首行 = ## 要验证的假设  （旧假设）
```

`drop → reopen` 同样不清（`reopen 后 verify.result = pass, evidence = 'e'`）。也就是说「已经放弃的假设」会跟着项目活到下一个生命周期，产物和 state 都留着旧结论。这与 F4 是同一个根因（`revise`/`reopen` 的重置不完整），但后果轻一些，单独记。

### F15　`drop` 的 `terminal` 被写两次（观察，不算 bug）

`state.js:481` 写一次 `draft.terminal = { kind:'dropped', reason:p.reason, at:nowIso() }`，`state.js:515` 又因为 `terminalByEvent.drop === 'dropped'` 再写一次同样的值。最终值正确，只是 `nowIso()` 被调两次（两次可能差 1ms，无影响）。留个记录，将来清理这个分支时别以为它只写一次。

---

## 3. 查过但**不是** bug 的（避免后人重复投入）

| 怀疑点 | 结论 | 证据 |
|---|---|---|
| payload 对象被 state 引用（aliasing） | **不存在**。`clone = structuredClone` 用对了，`tech_ok` 的 items、`clarify_done` 的 assumptions/constraints/baseline、`choose_build` 的 cards 全部是深拷贝；传入的 `state` 不被修改 | A/B/C/D 四组探针：改动 payload 后重新读 state，无共享引用；`state` 输入对象所有字段前后一致 |
| `minutes` 超大/非法（`1e10`、`MAX_SAFE_INTEGER`、`1e21`、`1.5`、`0`、负数、字符串） | **拦住了**。`validateTechItem` 用 `Number.isInteger(minutes) && minutes > 0`，以上全部拒绝 | 逐值实测，全部 `ok:false` |
| `checkBudget` 收负数 minutes | 单独调用返回 `{ok:true}`（`totalMinutes` 变小），但**通过 `validatePayload` 不可达**（前面已被 `Number.isInteger` 拦）。属防御性问题，不算可利用缺陷 | `applyEvent` 全路径实测拒绝 |
| `budget.mustUnderstand = 0` | **fail-closed**：`0` 是 finite，任何 user 项都会被拒。`resolveBudget` 又会把 `0` 映射回默认 5，所以 `createInitialState` 路径拿不到 0 | `{mustUnderstand:0}` 有 1 条 user 项 → 拒绝；`createInitialState({budget:{mustUnderstand:0}}).budget.mustUnderstand === 5` |
| `withStage` 双重包装 `plando：` / `——下一步：` | **没有**。三条会走 `withStage` 的路径都是 ×1 前缀、×1 下一步 | `validatePayload` 形状错 → `plando：`×1；`checkBudget` 完整形状 → ×1；`applyEvent` 内部 reason → ×1 |
| `effects.rerender` 越出契约 §1 白名单 | **没有**。全阶段×全事件扫描，只出现 `IDEA.md/TECH.md/VERIFY.md/HANDOFF.md/CHANGE-GUIDE.md/cards`；`effects` 的 key 只有 `rerender/invalidateCards/terminal` | 全组合扫描 |
| `drop` 的 `reason` 是否校验枚举 | **校验了**，`falsified/parked` 之外全部拒绝 | `'我懒得做了'`/超长/空串 → 拒绝 |
| `applyEvent` 是否改传入 state | **不改**（`structuredClone` 后只动 draft） | 输入 state 深比较前后一致 |
| `createdAt === updatedAt` | `createInitialState` 里相等（同一次 `nowIso()`），`applyEvent` 后 `updatedAt` 前进 1ms，符合预期。`project.saveState` 会再覆盖一次 `updatedAt`，所以 `state.js:502` 那次赋值在生产路径是死代码（无害） | 实测时间戳 |
| `pause`/`resume` 的 `noop` 形状 | `{ok:true, noop:true}` 不含 `state`，但 `tools.js:445` 有 `if (result.noop)` 特判，不会拿 `undefined` 去 `saveState` | 读码 + 实测 |
| `migrate` 对未知版本 | 报错且不重置（`schemaVersion: 'x'` / `2` / `-1` 全部 `ok:false`） | 逐值实测 |

---

## 4. 测试覆盖盲区（这些 bug 之所以全绿）

现有 `test/state.*.test.js` 共 101 个测试全过。逐个对照上面的发现：

- **没有任何一条**用重复 id 造 `choose_build` / `tech_ok`（F3/F6）
- **没有任何一条**把 `budget` 写成字符串数字（F2）；`state.budget.test.js` 的预算对象一律是数字字面量
- **没有任何一条**从 v0 迁移后再推进（`project.test.js:110` 只断言「升到 1 且不覆盖已有值」，没跑后续 `applyEvent`）（F1/F11）
- **没有任何一条**在 `revise` 之后检查 `verify` 是否残留（F4/F14）
- **没有任何一条**字符串含零宽字符（F9）
- `reason` 长度断言（`state.payload.test.js:14`）的输入都短到不触发截断，所以 `state.js`/`cards.js` 那个 161 的 off-by-one 一直是绿的（F7）。对比 `policy.test.js:214` 专门用超长 label+nextAction 测过截断——**同一个断言模板，一个漏测一个没漏**，说明问题不在断言本身，在于没人给 `state.js` 的 reason 造过超长输入
- `state.transitions.test.js` 的表驱动用例是「全事件 × 自己的 from 阶段」，天然不会覆盖「从 decide 调 tech_ok」这种跨阶段提示可达性（F8）

建议补的最小集：`choose_build`/`tech_ok` 重复 id、字符串预算、`migrate` 后立刻 `applyEvent`、`revise` 后 `verify` 为空、`reason` 长度用真正超长的 head+tail 构造、id 含 `../`。

---

## 5. 判决

**结论：`lib/state.js` 的状态机骨架是好的，但边界校验不够；v0.1.0 建议先修 3 条再发。**

先说好的部分，免得这份报告读起来像全盘否定：事件表（14 个事件 / 11 个阶段）、`pick` 与 `drop` 的歧义切开、`structuredClone` 的不可变风格、`effects` 提示面、`migrate` 对**未知版本**的拒绝、`drop reason` 的枚举校验、`tools.js` 里「已经是 `plando：` 形状就不再包第二层」的处理——这些都对，而且我逐条验证过（§3）。测试的**结构**也没问题（表驱动覆盖了 §2 全表），漏的是**形状**：所有用例都在用「合法但不刁钻」的数据。

再说不好的部分，按「是否在正常路径上会踩到」排序，而不是按我发现的顺序：

**A 类：不需要坏数据，正常用就会踩到（建议必修）**

1. **F3 重复卡 id 死锁** —— 模型漏写一个 `id` 就进死循环，且错误提示自相矛盾（让 `start` 一张已 `done` 的卡）。修法 2 行：`validateChooseBuild` / `validateTechOk` 加 id 唯一性。
2. **F5 卡 id 路径穿越** —— 模型给 `../../IDEA` 就能覆盖真实产物，给 `../../../x` 能写穿项目目录。这是唯一有**安全**性质的一条。修法：`state.js` 侧加 id 正则（3 行）；`tools.js` 的 `writeText` 再加一道 `path.resolve` 边界断言（同样 3 行，建议一起做，单靠正则很容易漏掉别的调用点）。
3. **F4 `revise` 复用旧 `verify`** —— 改了方向、工作量从 10 分钟扩到 500 分钟，仍然「验证过了」，`choose_build` 直接放行。这直接架空契约 §2 那条「large 必须先验证」。修法 1 行：`revise` 分支里重置 `verify`。

**B 类：需要磁盘上有 v0 草稿或手改过的 state，但后果不可逆（建议同批修，成本极低）**

4. **F1 `migrate` 把坏 state 洗白成 v1** —— 一旦写回，`schemaVersion` 变 1，以后永远不再迁移，坏字段永久留档；同时把原始 `TypeError` 丢给模型。修法集中在 `upgradeFromV0`：`resolveBudget`、`paused === true`、`cards` / `tech.items` 元素级校验。
5. **F2 字符串预算让预算门静默失效** —— 与 F1 同一行修复（`resolveBudget`）。实测 50 条 user × 99999 分钟被放行成 `large`。
6. **F7 `reason()` 161 字** —— 两处 `- 6` 改 `- 7`。契约 §5 写明 ≤160，现在是确定违约，只是需要长 payload 才看得到。

**C 类：确定但影响有限，可以进 0.1.1**

F6（重复 tech id 骗过覆盖校验）、F8（decide 的下一步提示不可达）、F9（零宽字符绕过非空）、F10（v1 不做形状校验）、F11（迁移不补 `tech.size`）——都建议修，但不会单独阻塞发布。

F12 是**契约与实现的确定性冲突**（契约 §3 要求 large 时 decide 推荐必须是 `verify`，实现是常量表）。按「以契约为准」的规矩，这条现在算欠账；要么改契约承认推荐通用，要么改 `format.js`。别放着不管。

F13 / F14 / F15 属记录性质。

**我的建议**：A 类 3 条 + B 类 3 条，合计约 20 行改动、全部落在 `state.js` 的校验与迁移函数里（F5 还需 `tools.js` 一处边界断言），可以在一轮内做完。做完之后这个状态机从「理想输入下正确」变成「坏输入下也不失守」，才配得上 v0.1.0 的语义版本号——因为它的产品定位就是「帮新手挡住自己」，挡住的前提是自己先挡得住。


---

## 6. 怎么复现这份报告

每条结论都有一个可重跑的脚本（放在系统临时目录，仓库里不新增文件——写作用域只允许 `docs/REVIEW-state.md`）：

```powershell
node $env:TEMP\repro-review-state.mjs
```

脚本按 F1–F12 编号分节，一次跑完输出上面所有「实测输出」。它用 `file:///A:/AI/plan-do-mode/lib/` 绝对路径 import，所以从任何目录运行都可以；其中 F1/F2/F11 会在临时目录里造真项目（`.plando/state.json` + `IDEA.md`）走 `project.loadState` 的真实迁移路径，F5 还会通过 `registerTools` 走完整的 `plando_transition → renderArtifacts → writeText` 落盘路径。

如果你只想验证某一条，把对应小节单独剪出来就行——每节内部都是自包含的 `mkdtempSync`，互不依赖。

---

*本报告只写结论，未修改 `lib/state.js`、`lib/cards.js`、`lib/tools.js` 或任何其它源文件。审查期间仓库工作树唯一的改动就是新增了本文件。*
