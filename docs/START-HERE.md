# START-HERE.md：这一套文件怎么用

> 一句话：**写这个插件不需要创造模式；只有「把插件装进 DSH」这一步需要。**
> 而且开发和使用的会话必须分开——详见第四节。

## 一、这些文件分别是什么

| 文件 | 给谁看 | 什么时候看 |
|---|---|---|
| [PLAN.md](../PLAN.md) | 你 + 实现者 AI | 需求与验收标准（A1–A9）。**这是需求，不能改** |
| [DEV-PROMPTS.md](DEV-PROMPTS.md) | 你 | 怎么把开发工作交给 AI：L1 前缀 + R0–R7 任务卡 + 验收卡 |
| [CONTRACT.md](CONTRACT.md) | 实现者 AI | state.js 的精确契约：阶段/事件/payload/错误消息 |
| [API-FACTS.md](API-FACTS.md) | 实现者 AI | DSH 插件 API 的已验证事实，防止它凭空编 API |
| [../scripts/check-docs.mjs](../scripts/check-docs.mjs) | 你 | `node scripts/check-docs.mjs` 检查四份文档互相引用一致 |

阅读顺序：本文件 → PLAN.md → DEV-PROMPTS.md。另外两份是实现时喂给 AI 的，你不用通读。

## 二、三种用法，选一种

### 场景 A：在当前这个会话里直接开跑（最快）

当前会话已经是 **full access**，且有 `write` / `edit` / `pwsh` / `read`，够用。

1. 先定掉 DEV-PROMPTS 第十节的 4 个输入（包名、budget、persona 篇幅、docs 是否进包）。
2. 把 DEV-PROMPTS 的 **L1 固定前缀 + R0 任务卡**贴进来（或者直接说「按 R0 开跑」——同一个会话里 AI 能自己读文件，不必真的复制粘贴）。
3. 每轮结束检查三样：`node --test` 通过数、`git log --oneline -1`、有没有动到任务卡以外的文件。
4. 过了就进入下一轮。

> 提示词的意义在于「换人」时不用重新解释背景。同一个会话里 AI 已经读过上下文，可以直接干。

### 场景 B：另开一个会话开发（推荐）

理由：开发上下文很长，和讨论混在一起会互相挤占。

1. 新会话选 **standard**（或任何带 `write`/`edit`/`pwsh` 的预设），工作区设为 `A:\AI\plan-do-mode`。
2. 贴 **L1 固定前缀 + R0 任务卡**。
3. 之后每轮只贴「L2 任务卡」，L1 不用重复（同一会话内它记得）。
4. 上下文快满时，让它写 `docs/HANDOFF-<轮次>.md`，然后新会话贴 L1 + 「先读 HANDOFF-xx.md 再继续」。

### 场景 C：换成别的 AI / 别的产品

1. 把 **L1 固定前缀 + 一张任务卡 + CONTRACT.md + API-FACTS.md** 一起给它（它读不到我们的对话）。
2. L1 里的路径约束（仓库位置、不改 `A:\AI\glim`）必须保留。
3. 验收命令不变——这是唯一跨 AI 通用的部分。

## 三、创造模式到底什么时候需要

| 你要做的事 | 需要创造模式吗 | 说明 |
|---|---|---|
| 写 `lib/*.js`、写测试 | **不需要** | 任何有 `write`/`edit` 的会话 |
| 跑 `node --test`、`git commit` | **不需要** | `pwsh` 就够 |
| `plugin_manager install_bundle` / `list_plugins` / `remove_bundle` | **需要** | 这个工具只在创造模式（或 `cordis` 类预设）里 |
| `dsh plugin --profile desktop add ...` | 不需要，但**只完成一半** | 见下 |
| 在 dshmarket 界面一键装 | 不需要 | 需要插件先进索引 |
| 新建会话选「边学边做」 | **不需要** | 装好后普通会话即可 |
| 跑冒烟流程（记灵感 → … → 收尾） | **不需要** | 用「边学边做」预设的普通会话 |

**关于 `dsh plugin`（2026-11-25 本机实测）**：

- CLI 在 `A:\deepseek harness\resources\runtime\cli\bin\dsh.cmd`，**不在 PATH**，要写全路径。
- `dsh --profile desktop --dump-default-config` 报 `profile "desktop" is managed exclusively by the Electron application`
  —— 桌面 profile 由 Electron 独占管理。
- `dsh plugin --profile <name> <pnpm-args...>` 是 **pnpm 透传**（`list` 实测可用），
  所以它大概率只装依赖，**不一定把包名写进 `dsh.profile.bundles`**。

结论：**装插件走创造模式的 `plugin_manager action=install_bundle`**，装完用 `list_plugins` 确认，
不要只靠 CLI。

## 四、最容易踩的坑：开发会话 ≠ 使用会话

| | 开发这个插件 | 使用「边学边做」 |
|---|---|---|
| 用什么预设 | standard / 创造模式 | **边学边做** |
| 有 `write`/`edit` 吗 | 有 | **故意没有**（`write:false, edit:false`） |
| 有 `bash`/`pwsh` 吗 | 有 | **故意没有** |
| 守卫 | 无 | 非 build 阶段一律拒绝改文件 |

所以：

- **不要**在「边学边做」会话里开发这个插件——AI 根本写不了文件，守卫还会拦。
- **不要**在 standard 会话里跑 plan-do 流程——没有工具、没有守卫，等于没装。
- 装好之后想改插件：切回 standard 会话改代码，再重启/重装，再回「边学边做」会话验。

## 五、一次完整的验证长什么样

```text
1. 创造模式会话
   plugin_manager action=install_bundle target=A:\AI\plan-do-mode
   plugin_manager action=list_plugins        → 确认 preset-plan-do 存在、状态不是 failed

2. 新建会话 → 预设列表选「边学边做」 → 工作区设成一个空的临时目录

3. 冒烟（照 PLAN 第九节）
   记一条灵感 → 三问 pick → 澄清 → IDEA.md 生成 → TECH.md 生成
   → 选路 → 一张卡（学/做/验）→ 收尾
   负向：让它「直接帮我写这个文件」→ 必须被拒，或工具列表里根本没有 write
   负向：plando_scaffold 写 package.json 成功、写 src/app.js 被拒

4. 检查临时目录：.plando/state.json、IDEA.md、TECH.md、git log

5. 创造模式会话卸载 → 预设列表里「边学边做」消失，~/.plando 仍在
```

## 六、日常只需要记三条

1. `node scripts/check-docs.mjs` —— 改了文档就跑一次，引用断了它会报。
2. `node --test` —— 每轮结束必须全绿，AI 贴出来的证据里要看这个。
3. **验收标准不降** —— AI 为了让测试变绿而放宽断言，是这个项目最大的风险，用 DEV-PROMPTS 的 L3 红队卡查。
