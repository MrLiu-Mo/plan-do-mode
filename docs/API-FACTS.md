# API-FACTS.md：DSH 插件 API 的已验证事实

> **这份文件的唯一作用**：让实现者 AI 不用猜 API。
> 下面每一条都来自 `A:\AI\glim\dsh\glim-mode\lib\*.js`——那是一个**已经装进 DSH 并跑起来过**的插件。
> 凡是这里没写的东西，都不要凭印象补；先读 glim-mode 的源码，或者问人。

事实源（可随时复核）：

- `A:\AI\glim\dsh\glim-mode\lib\index.js` — 模块契约 + 守卫挂载
- `A:\AI\glim\dsh\glim-mode\lib\tools.js` — 手工拼 ToolDefinition
- `A:\AI\glim\dsh\glim-mode\lib\policy.js` — 同步守卫规则
- `A:\AI\glim\dsh\glim-mode\cordis.patch.yml` — preset 插入写法
- `A:\AI\glim\test\dsh-mode.test.js` — 假 ctx / 动态 import / 静态禁裸包名

---

## 1. 插件模块契约

```js
export const name = 'plan-do-mode';        // 必须导出，字符串
export const inject = ['tools'];           // 只依赖工具注册表
export function apply(ctx, config) { ... } // 同步；不要 async
```

- `apply` 里拿不到 `ctx.tools.register` 或 `ctx.tools.guard` 时，**抛错**（宁可挂不上，也别假装拦住了）。
- 配置手工校验，不引 `schemastery`（见 §6）。

## 2. 工具注册

```js
ctx.tools.register(toolDefinition);
```

`toolDefinition` 是**纯对象**（不用 `defineTool`）：

```js
{
  name: 'plando_status',              // 模型看到的工具名
  description: '...',                 // 给模型看的用途说明，中文
  parameters: {                       // 原始 JSON Schema，不是 zod/schemastery
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'list', 'init'], description: '...' },
      dir:    { type: 'string', description: '...' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'string' },        // 输出是纯文本
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args) { return '一段文本'; },
}
```

要点：

- **没有自动参数校验**：`execute` 自己检查，缺参数就 `throw new Error('缺少必填参数 x')`——这条错会直接显示给模型，所以要写人话。
- `execute` 的返回值会被 `output.render` 包装成 content block；返回字符串即可。
- 想让某个参数接受任意 JSON 对象，就**不写 `type`**，只写 `description`（glim 的 `payload` 就是这么干的）。
- 模型有时把 JSON 当字符串塞进对象参数，`execute` 里要顺手 `JSON.parse` 一次（见 glim `normalizePayload`）。
- 工具名是**硬编码**的；如果用户装了改名工具，守卫名单要跟着改（这是已知限制，不是 bug）。

## 3. 守卫（「不代写」的落点）

```js
ctx.tools.guard((exec) => {
  // exec.name 是模型要调用的工具名
  return undefined;        // 放行
  // 或返回一个字符串      // 拒绝，字符串就是拒绝理由（会显示给模型）
});
```

已验证的语义：

- **同步**：不能 `await`、不能读网络；一次函数调用内必须判完。
- **单调**：一旦返回拒绝理由，后面的监听器改不回「允许」。
- **`exec.name`** 是唯一可靠字段；不要假设还有别的。
- 状态读不出来时，glim 选择**放行**（宁可少拦一次，也不要把会话锁死）；
  plan-do 的取舍相反：**写类工具 fail-closed，只读工具放行**（PLAN §5）。
  两种都可以，但必须在测试里写死自己的选择。

## 4. 模块加载与零依赖

- 本包**只 import `node:` 内置模块和本目录文件**。
- `install_bundle` 用 `link:` 把目录链进 profile，被链目录没有 `node_modules`，
  任何 `@deepseek-ai/*` 裸包名在 import 阶段就 `ERR_MODULE_NOT_FOUND`，
  界面显示「加载失败 / never started」。
- 所以**不能用** `defineTool`、不能用 `schemastery` 的 `Config`、不能 import 任何 `@deepseek-ai/*`。
- 需要读别的模块时用 `createRequire(import.meta.url)`（glim 用它加载自己的 core），
  但 plan-do **不需要**——它没有外部 core。

## 5. 测试约定（照 glim `test/dsh-mode.test.js`）

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Windows 上 import() 绝对路径必须先转 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const asUrl = (file) => pathToFileURL(file).href;
const mod = await import(asUrl(path.join(BUNDLE_DIR, 'lib', 'policy.js')));
```

假 ctx（测 `apply()` 用）：

```js
function fakeCtx() {
  const registered = [];
  const guards = [];
  return {
    registered, guards,
    ctx: { tools: { register: (def) => registered.push(def), guard: (fn) => guards.push(fn) } },
  };
}
```

必备的四条「守住地基」用例：

1. `await import(lib/index.js)` 能用**裸 node** 导入成功（证明零依赖真的成立）。
2. 静态扫描 `lib/*.js`，出现 `@deepseek-ai/` 或 `from '<非 node: 非相对路径>'` 即失败。
3. `apply(fakeCtx().ctx, {})` 后 `registered` 的工具名列表与 CONTRACT 完全一致。
4. `guards.length === 1`，且 `guards[0]({ name: 'write' })` 是字符串、`guards[0]({ name: 'read' })` 是 `undefined`。

测试不碰真目录：一律 `fs.mkdtempSync(path.join(os.tmpdir(), 'plando-'))`，
**绝不允许**测试写 `~/.plando` 或用户项目。

## 6. 预设（bundle patch）写法

`cordis.patch.yml` 是 profile 的一个 patch 层，顶层是数组，用 `insert` 加节点：

```yaml
- insert:
    - id: preset-plan-do
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: plan-do
        name: 边学边做
        description: 把一个小想法一步步学会并做出来：AI 只教、只验收，不代写。
        order: 25
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你在「边学边做」模式下工作……
          - id: plan-do-mode
            name: 'dsh-plan-do'          # ← 就是本包的包名
            config: { dataRoot: '', autoCommit: false }
```

已验证：

- `config.plugins[]` 里每一项是 `{ id, name, config? }`，`name` 是**包名**（不是路径）。
- 平台分支可以写 `disabled: !!js process.platform === 'win32'`（`!!js` 表达式是支持的）。
- 分组用 `name: cordis:group` + `group: true` + `config: [...]`（compaction / delegation 就是这么写的）。
- 用户本地 `cordis.patch.yml` 在 bundle 层之后应用，可以按 `id` 覆盖 config。
- **不要**挂 `@deepseek-ai/dsh-plan-mode`：两套流程叠加会互相打架（glim 已验证）。

## 7. 已知会踩的坑

| 坑 | 表现 | 正确做法 |
|---|---|---|
| import 了裸包名 | 插件页「加载失败 / never started」 | 零依赖；测试用例 2 守住 |
| `apply` 写成 async | preset 挂载时序不可预期 | 同步；异步工作放工具 `execute` 里 |
| 守卫里 `await` | 守卫静默失效 | 只读内存里的状态快照 |
| Windows 上 `import()` 绝对路径 | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `pathToFileURL` |
| 用 `write`/`edit` 工具写产物 | 自己撞自己的守卫 | 用 `node:fs` 在插件里写 |
| 把阶段存内存 | 换会话/重启就丢 | 唯一真相源是 `.plando/state.json`，每次读盘 |
| `git add -A` | 提交了用户正在写的代码 | 只 `git add --` 模式产物清单 |
