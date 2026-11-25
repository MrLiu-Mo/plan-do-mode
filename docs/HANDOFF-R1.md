# HANDOFF-R1：lib/state.js 实现说明

对应任务 task-1（R1a+R1b）。契约以 `docs/CONTRACT.md` §1/§1.1/§2/§3/§5 为准，本文件只记实现取舍。

## ① 导出了什么

名字与 CONTRACT §1.1 逐字一致，全部具名导出，**零 import**（静态扫描确认无 `import` / `require`）：

| 导出 | 说明 |
|---|---|
| `SCHEMA_VERSION` | 1 |
| `STAGES` | 11 项，顺序同 §1 |
| `TERMINAL_STAGES` | `done / handoff / dropped` |
| `STAGE_LABELS` | 11 项中文名（如 tech → 技术拆解） |
| `NEXT_ACTIONS` | 11 项「下一步该做什么」 |
| `TRANSITIONS` | 14 个事件，`{ from: string[], to: string \| null }` |
| `canTransition(state, event)` | 纯查表，不校验 payload |
| `validatePayload(event, payload, config)` | 与 state 无关的 shape 校验 |
| `applyEvent(state, event, payload, config)` | 返回 `{ ok, state?, reason?, effects?, noop? }` |
| `computeSize(items, constraints)` | `{ size, sizeReason, totalMinutes }` |
| `checkBudget(items, budget)` | `{ ok, reason? }` |
| `migrate(state)` | `{ ok, state?, reason? }` |
| `createInitialState(project)` | 初始 stage = `clarify`（inbox 阶段由 plando_idea 立项，不产生 state） |

`effects` 只出现契约白名单的值：`rerender` ⊆ `IDEA.md / TECH.md / VERIFY.md / HANDOFF.md / CHANGE-GUIDE.md / cards`；
`revise` 额外给 `invalidateCards`；`ship_pass / choose_handoff / drop` 给 `terminal`。

## ② 关键判断

- **TRANSITIONS 的 from 列表**：逐字按 §2 表格。
  `drop` / `pause` / `resume` 的 from 是「任意非终态」= `STAGES` 减去 `TERMINAL_STAGES`（8 项），
  运行时算出来而不是手写，避免以后加阶段时漏改。
  `pause` / `resume` 的 `to` 用 `null` 表示「阶段不变」——这样 `applyEvent` 里统一写
  `if (t.to) draft.stage = t.to`，不会把阶段误设成字符串 `'null'`。
- **id 分配**：`tech_ok` 按数组下标给 `t1、t2…`，`choose_build` 给 `c1、c2…`；调用方显式带了合法
  `id` 的就沿用（revise 后重传整份清单靠这条保持稳定）。不做「全局不复用」，因为 CONTRACT 没给
  持久计数器，硬做会让重传清单时 id 漂移，反而破坏卡上的 `techIds` 引用。
- **校验分两层**：`validatePayload` 只做与 state 无关的 shape 校验（它拿不到 state）；依赖 state 的
  检查（TECH 项被卡覆盖、`size=large` 必须先验证、`cards_done` 时卡状态）放在 `applyEvent` 里。
  因此 `validatePayload` 的 reason 里没有「现在是哪个阶段」，由 `applyEvent` 用 `withStage()` 补。
- **错误消息**：`reason(where, why, next)` 统一拼 `plando：…——下一步：…`，按「字符」而非字节截断到
  160 字，且**只截中间的 why**，保证 `plando：` 前缀、`——下一步：` 与下一步动作一定还在（测试会断言）。
- **预算**：`checkBudget` 同时说「超了多少」和「怎么降级」两个数字（§3 要求），默认 `{5, 600}`。
- **`pick`**：在 `validatePayload` / `applyEvent` 都显式报错，理由固定指向 `plando_idea action=pick`（§2.1）。
- **不可变**：全程 `structuredClone` 出 draft 再改，传入 state 逐字节不变（冒烟脚本断言过）。

## ③ 踩到的坑（给下一个写 state 测试的人）

1. `withStage()` 一开始无条件插阶段，把 `checkBudget` 已经完整的 reason 包成
   `plando：现在是「技术拆解」阶段，plando：技术清单超出预算…——下一步：…——下一步：…`（两个前缀两个
   下一步）。现在改成「整体长度超 160 时才截、且保住尾部」。
2. `done` 启发式校验不能只做 `includes`：`能点开页面，实现了` 是合法现象。实现是「去掉标点后，
   若剩下的内容全由 4 个空话词拼成」才拒。
3. `resume` 在未暂停时必须返回 `{ ok: true, noop: true }`（§2），不能顺手把 `paused` 写成 false 就返回 state——
   我按契约返回 noop 且不带 state，**调用方（tools.js）需要自己判断有没有 state 可写**。
4. `createInitialState` 的 `projectId` 用 `Math.random().toString(36).slice(2,10)` 可能不足 8 位，
   改成攒够 8 位（`proj_<8位>` 是 CONTRACT §4 写死的形状）。
5. 零依赖是硬约束：`structuredClone` 是运行时内置，不要为了深拷贝去 import `node:util`。

## ④ 已知没做 / 需要 Lead 定的地方

- **未写测试**（按分工由另一个人写 `test/state.test.js`）。本文件的自验是临时脚本，没有进仓库。
- **`drop` 的 from 含 `inbox`**：§2 写「任意非终态」，§2 备注又写「已立项才有意义」，两处冲突。
  我按表格字面实现（inbox 可 drop），若 Lead 认为 inbox 项目不该进入状态机，请把 `drop.from`
  改成 `NON_TERMINAL_STAGES.filter(s => s !== 'inbox')`。
- **`migrate` 的「已知旧版本」集合**：CONTRACT 只说「已知旧版本升版」，没说是哪个数字。我实现为
  `0` 是已知旧版（补齐字段，不覆盖已有值），`> 1` 或非整数一律报错不重置。若将来真出现 v2，需要改
  `SCHEMA_VERSION` 并加升级分支。
- **`verify.overtime` 没有任何事件会置 true**（payload 里没有这个字段）。目前恒为 false，
  留给 tool 层在 `verify_result` 前根据时间盒判断，或后续加事件字段。
- **`terminal.reason`**：`ship_pass` / `choose_handoff` 写入 `''`（契约要求 string，但这两个事件没有
  reason payload）。
- `applyEvent` 不写日志（`log.jsonl` 的 reject 记录在 §5 属于调用方职责），也不重渲染产物——
  只返回 `effects` 提示。
