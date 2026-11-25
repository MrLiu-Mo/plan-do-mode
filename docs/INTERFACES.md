# INTERFACES.md：模块间的内部接口（R5 起生效）

> 这份文件只管「模块之间怎么调」，不管「对模型怎么表现」。后者看 CONTRACT.md。
> 定这份文件的理由：R5 的四个文件由两个人并行写，没有一份写死的接口就必然对不上。

## 1. 依赖方向（单向，不许回头）

```
index.js  →  tools.js  →  { state, project, artifacts, cards, checks, scaffold, git, config, policy, format }
                            ↑ 全部是纯函数或薄 IO，不认识 ctx
```

- `policy.js` / `format.js` **不许** import `tools.js`。
- `format.js` **不许**读写文件（只吃数据吐字符串）。
- 任何模块都不许 import `@deepseek-ai/*`（API-FACTS §4）。

## 2. `lib/policy.js`

```js
// 能力分类：按能力列、不按记忆列（PLAN §5）。返回 'fs-write'|'shell'|'dynamic-code'|'subagent'|'read'|'plando'|'unknown'
export function classifyTool(name);

export const DENY_CAPS;   // ['fs-write','shell','dynamic-code','subagent']

// 造守卫。deps 里的两个函数由 tools.js 注入，policy 自己不去碰文件系统。
//   getStateContext() -> { stage, label, nextAction, paused } | null   // null = 状态读不出来
//   getConfig()       -> config 对象（含 guardExtraDeny: string[]）
export function createGuard(deps);

export function denyReasonFor(name, ctx);   // -> string，供 createGuard 内部与测试复用
```

**守卫语义**（PLAN §5，测试要写死）：

| 情况 | 结果 |
|---|---|
| `name` 以 `plando_` 开头 | 放行（`undefined`）——plando 工具自带阶段校验 |
| 能力是 `read` / `unknown` | 放行 |
| 能力是 `subagent` / `dynamic-code` | **永远拒绝**，不管状态读不读得到 |
| 能力是 `fs-write` / `shell`，且状态读不出来 | **拒绝**（fail-closed） |
| 能力是 `fs-write` / `shell`，有状态 | 拒绝，理由里带阶段名 + 下一步 |
| `guardExtraDeny` 里点名 | 永远拒绝 |

拒绝理由必须是 `plando：…——下一步：…` 形状、≤160 字、无 emoji。

## 3. `lib/format.js`

全部是 `(数据) => string`，不抛错（数据缺字段时给 `—`），不看时钟。

```js
export function formatStatus({ state, projectDir, progress, pending, artifacts, budget });
// -> 多行文本：阶段、一句话下一步、暂停/超时提醒、卡进度、产物清单、预算余量

export function formatProjectList(list);        // list: [{ name, dir, stage, updatedAt, ok, reason? }]
export function formatIdeaList(ideas);          // ideas: [{ id, title, at, parked?, picked? }]
export function formatCard(state, card);        // 单卡：学/做/验三段现状 + 缺什么
export function formatTransition(ok, { event, from, to, effects, reason });
export function formatCheck({ ok, name, exitCode, stdout, stderr, reason });
export function formatRecover(reason, dir);     // 状态损坏时的恢复指引（CONTRACT §4：绝不重置）
```

## 4. `lib/tools.js`

```js
export function registerTools(ctx, deps);
// deps = { config, paths, state, project, artifacts, cards, checks, scaffold, git, policy, format }
// 返回已注册的工具名数组，供 index.js 与测试断言

export const TOOL_NAMES;   // ['plando_idea','plando_project','plando_status','plando_clarify',
                           //  'plando_transition','plando_card','plando_check','plando_scaffold']
```

每个工具的 `definition` 形状照 API-FACTS §2：纯对象、手写 JSON Schema、`execute(args)` 返回字符串。

**统一的 `execute` 包装**（tools.js 内部一个函数，8 个工具都走它）：

```js
async function run(toolName, args, body) {
  // 1. 参数形状不对 -> 返回 format.formatError(...) 文本，不抛
  // 2. body 抛错 -> catch 成 `plando：…——下一步：…` 文本返回（工具永远不把异常抛给模型）
  // 3. 返回 string
}
```

**公共前置**：除了 `plando_project(action=init/list)` 与 `plando_idea`，其余工具都要先定位项目：
从 `args.dir` 或 `config.defaultProjectDir` 拿目录，`project.loadState(dir)`；
读不出来 → 返回 `format.formatRecover(reason, dir)` 或「先用 plando_project action=open」。

## 5. `lib/index.js`

```js
export const name = 'plan-do-mode';
export const inject = ['tools'];
export function apply(ctx, config) { /* 同步 */ }
```

`apply` 里：

1. `readConfig(config)` 得配置（配置非法 → 抛错，宁可挂不上也别假装能用）。
2. 组装 `deps`，调 `registerTools(ctx, deps)`。
3. `ctx.tools.guard(createGuard({ getStateContext, getConfig }))` **只挂一次**。
4. `ctx.tools.register` 或 `ctx.tools.guard` 缺失 → `throw new Error(...)`。

`getStateContext()` 每次调用都**重新读盘**（阶段唯一真相源是 `.plando/state.json`），
读不到返回 `null`；不要缓存到模块级变量。

### 5.1 「当前项目」的解析（实现中发现的必要性）

守卫拿到的 `exec` **只有 `name`**（API-FACTS §3），它不知道模型这次要操作哪个项目。
如果守卫只会读 `config.defaultProjectDir`，用户显式传 `dir` 打开别的项目时，
守卫会读到**错的项目**（更糟：读不到 → fail-closed 把只读操作也拦了）。

所以：`deps.runtime.activeProjectDir` 存**最近一次 `plando_*` 调用解析出的项目路径**。

- **可以缓存路径，不可以缓存状态**。守卫每次调 `getStateContext()` 都重新 `loadState(activeProjectDir)`。
- 优先级：`runtime.activeProjectDir` → `config.defaultProjectDir` → `null`（→ 由 policy 决定 fail-closed）。
- `classifyTool(undefined)` 归 `unknown` 并放行（INTERFACES §2 语义表）；
  否 —— `subagent` / `dynamic-code` 与 `guardExtraDeny` 点名的仍然拒绝。
