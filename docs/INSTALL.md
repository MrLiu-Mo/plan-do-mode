# INSTALL.md：安装与冒烟验证

> 装插件本身花不了两分钟，**验证它真的在管你**才是这页的重点。
> 这里的每条命令都在 Windows + DSH 0.2.1-rc.2 上实测过；命令输出与你看到的不完全一样是正常的。

## 1. 先决条件

- DSH 已装好，能打开 Web 或 Desktop 界面。
- **一个「创造模式」的会话**：安装/卸载插件要通过 `plugin_manager` 工具或 `dsh plugin` 命令，
  这两条路都要求会话有插件管理权限。普通会话里 `plugin_manager` 不会出现。

> 写代码、用「边学边做」模式**都不需要**创造模式。创造模式只在「装 / 卸 / 列插件」时用到。

## 2. 三条安装路径（选一条）

### 2.1 npm（插件发布之后）

```bash
dsh plugin --profile <profile> add dsh-plan-do
```

`--profile` 是**必填**的，省略会直接报 `error: required option '--profile <name>' not specified`。
`dsh plugin` 把其余参数原样透传给 pnpm，所以 `add` / `remove` / `install` 这些动词都能用。

更稳的做法是在**创造模式会话**里让 AI 调工具：

```text
plugin_manager action=install_bundle target=dsh-plan-do
```

### 2.2 GitHub Release 的 tgz

从 [Releases → v0.1.0](https://github.com/MrLiu-Mo/plan-do-mode/releases/tag/v0.1.0) 下载
`dsh-plan-do-0.1.0.tgz`，然后：

```bash
dsh plugin --profile <profile> add ./dsh-plan-do-0.1.0.tgz
```

或直接给 URL：

```bash
dsh plugin --profile <profile> add -w "https://github.com/MrLiu-Mo/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"
```

或在创造模式会话里：

```text
plugin_manager action=install_bundle target=<tgz 的绝对路径>
```

> **仓库已转 public，上面那条下载 URL 匿名可访问**（实测 200 + 152 kB + 校验和一致）。
> 若哪天又改回 private，同一条 URL 会对未登录的人返回 **404（不是 401）**，别人只会看到
> 「找不到」而看不出是权限问题。判据：
> `curl -sSL -o NUL -w "%{http_code}" https://github.com/MrLiu-Mo/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz`
> 应为 200。
>
> **tgz 的校验和只写在 Release 页面上，不写在这份文档里。** `docs/` 会打进 tgz，
> 把包的校验和写进包内文档是自指的：改这行字 → 包就变了 → 校验和立刻失效。

### 2.3 本地目录（开发时最常用）

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

它用 `link:` 把目录链进 profile。**注意**：被链的目录里没有 `node_modules`，
所以本包必须零依赖——这是硬约束，`test/index.test.js` 里有静态扫描守着。

## 3. 装完在哪看到它

1. 新开一个会话，打开预设选择器。
2. 列表里应出现 **「边学边做」**（id `plan-do`，排序 25）。
3. 选中它之后，模型手上只有 8 个 `plando_*` 工具和只读文件工具——**没有** `write` / `edit` / `bash`。
4. 让它调 `plando_status`，它应该告诉你「还没有项目，先用 plando_project action=init 或 plando_idea action=add」。

如果第 2 步看不到，去看插件页：显示「加载失败 / never started」基本都是 import 了裸包名。

## 4. 冒烟验证清单（5 分钟，逐条打勾）

在**新开的「边学边做」会话**里做，不要用开发这个插件的会话。

### 4.1 守卫真的在拦

```text
你：请用 write 工具在项目根写一个 hello.txt
```

应当被拒绝，理由形如
`plando：现在是「灵感收集」阶段，这个模式不允许写文件——下一步：先把想法记下来，用 plando_idea action=add。`

**判据**：出现了 `plando：` 前缀和「下一步」，而不是「工具不存在」或直接成功。
（如果显示的是「工具不存在」，说明预设没挂写工具——那是更彻底的一层，同样合格。）

### 4.2 状态真的能落盘

```text
你：帮我记一个想法：做一个能导出 Markdown 的记账小工具
```

模型应调 `plando_idea action=add`，然后在 `~/.plando/ideas.json` 里出现这条记录。

**判据**：文件存在、JSON 可解析、里面有刚记的那条。没有的话看 `dataRoot` 配置。

### 4.3 立项后阶段真的会变

```text
你：就做这个，选它
```

模型应调 `plando_idea action=pick`（要过三问），项目目录被创建，
`.plando/state.json` 里 `stage` 变成 `clarify`。

**判据**：`.plando/state.json` 存在、`schemaVersion: 1`、`stage: "clarify"`、`budget` 快照在。

### 4.4 产物由 state 渲染，不是模型手写

走完澄清后调 `plando_transition`（`event: clarify_done`），项目根应出现 `IDEA.md`，
并且它开头的 8 个小节标题一字不差。

**判据**：把 `IDEA.md` 的标题行与 `docs/CONTRACT.md` §6 对照，逐字相同。
模型不能手写产物——它没有写工具，产物只能由 `lib/artifacts.js` 渲染。

### 4.5 坏状态不被重置（最重要的一条）

手改 `.plando/state.json`，把 `schemaVersion` 改成 `99`，然后让模型调 `plando_status`。

**判据**：它报错并给出恢复建议（`formatRecover` 的输出），**而不是**把状态重置成初始值。
重置了就是严重 bug——用户的进度没了，而且没人知道发生过。

验完把它改回 `1`。

## 5. 卸载

```bash
dsh plugin --profile <profile> remove dsh-plan-do
```

或在创造模式会话里：

```text
plugin_manager action=remove_bundle target=dsh-plan-do
```

实测：本机版本会同时清掉 profile 里 `dependencies` 和 `dsh.profile.bundles` 两处引用。
卸载后预设列表里「边学边做」应消失。

**卸载不会删你的数据**：`~/.plando/` 和各项目的 `.plando/` 都还在。要清就自己删。

## 5.5 A9 逐条走：装得上、卸得干净

A9 是**唯一没法自动化**的验收项（`scripts/smoke-pack.mjs` 只覆盖「包解开后能加载、能跑通
init→clarify→idea」那半）。下面这 9 步按顺序做，每步都给了「该看到什么」——
**看到的不一样就停下来，把原文贴回给我**，不要自己猜着往下走。

> 用**本地 tgz** 装，不要用 `link:` 目录。tgz 是真正会发给别人的那个形状，
> 它才验得了「`files` 白名单有没有漏文件」这件事；`link:` 指向仓库目录，永远看不出漏打包。

### 5.5.1 准备（在仓库目录里，普通会话即可）

```bash
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" pack
```

**该看到**：`dsh-plan-do-0.1.0.tgz`，约 152 kB，`npm notice total files: 29`。
（`*.tgz` 在 `.gitignore` 里，不会污染仓库。）

### 5.5.2 装（创造模式会话）

```text
plugin_manager action=install_bundle target=A:\AI\plan-do-mode\dsh-plan-do-0.1.0.tgz
```

**该看到**：成功回执，没有 `ERR_MODULE_NOT_FOUND` / `never started`。

### 5.5.3 确认真的注册上了（创造模式会话）

```text
plugin_manager action=list_plugins
```

**该看到**：列表里有 `preset-plan-do`，状态**不是** `failed`。
看不到、或状态是 `failed`，就是加载阶段挂了——最常见原因是包里漏了 `lib/` 某个模块。

### 5.5.4 确认预设出现在选择器里（**新开**一个会话）

新开一个会话 → 打开预设选择器。

**该看到**：「边学边做」（id `plan-do`，排序 25）。
**这一步是 A2 / A3 的判据**：`list_plugins` 里有、但选择器里没有，说明 preset 节点没插进去。

### 5.5.5 确认「不代写」真的生效（在「边学边做」会话里）

把工作区设成一个**空的临时目录**（不要用 `A:\AI\plan-do-mode`），然后：

```text
你：请用 write 工具在项目根写一个 hello.txt
```

**该看到**（两种都合格，说明不同但结论相同）：

- 模型说「没有 write 工具」——预设没挂写工具，这是第一道防线；或
- 出现 `plando：现在是「灵感收集」阶段，这个模式不允许写文件——下一步：…`——守卫拦住了，第二道防线。

**不合格**：文件真的被写出来了。那是严重 bug，立刻停下贴回来。

### 5.5.6 确认状态真的落盘（同一个会话）

```text
你：帮我记一个想法：做一个能导出 Markdown 的记账小工具
```

**该看到**：模型调 `plando_idea action=add`；`%USERPROFILE%\.plando\ideas.json` 出现这条记录。

```powershell
Get-Content "$env:USERPROFILE\.plando\ideas.json" -Encoding UTF8
```

### 5.5.7 记下卸载前的证据（为了 5.5.9 对比）

```powershell
Test-Path "$env:USERPROFILE\.plando\ideas.json"          # 该是 True
Get-ChildItem "$env:USERPROFILE\.plando" | Select-Object Name
```

把输出**记下来或截图**——第 9 步要证明「卸载没删数据」。

### 5.5.8 卸（回到创造模式会话）

```text
plugin_manager action=remove_bundle target=dsh-plan-do
```

**该看到**：成功回执。

### 5.5.9 验卸载（三件事都要对）

1. `plugin_manager action=list_plugins` → **没有** `preset-plan-do` 了。
2. 再**新开**一个会话 → 预设选择器里**没有**「边学边做」了。
3. 数据还在：

```powershell
Test-Path "$env:USERPROFILE\.plando\ideas.json"          # 仍是 True
```

**不合格**：第 3 步变 `False`。卸载删用户数据是严重 bug。

### 5.5.10 把结果贴回来

我需要这四项，其它细节不用：

| 步骤 | 贴什么 |
|---|---|
| 5.5.2 / 5.5.3 | `install_bundle` 的回执 + `list_plugins` 里 `preset-plan-do` 那一行 |
| 5.5.4 | 预设选择器里能不能看到「边学边做」（看得到 / 看不到） |
| 5.5.5 | 那句拒绝的**原文** |
| 5.5.9 | 三件事各自的结论 |

## 6. 开发者自查（改完代码之后）

```bash
node --test                     # 423 条，必须全绿
node scripts/check-docs.mjs     # 文档与代码的交叉引用一致
node scripts/verify-pack.mjs    # 分发包清单完整（真跑 npm pack --dry-run）
node scripts/smoke-pack.mjs     # 分发包冒烟：真打包 → 解开 → 真加载 → 跑一遍流程
```

前四条都在 CI 里跑（`.github/workflows/test.yml`，ubuntu + windows 双平台）。

**发布前再加一条**（不进 CI，因为它会检查工作区干净）：

```bash
node scripts/release-check.mjs  # 元数据填全了吗、文档里还有仓库地址占位符吗、工作区干净吗
```

它现在**是绿的**（仓库地址已定：`github.com/MrLiu-Mo/plan-do-mode`）。注意它只在**发布前那一刻**
需要绿：开发期工作区总有未提交改动，那条会报「工作区不干净」——这是**预期行为**，不是 bug。
发布流程见 [RELEASE.md](RELEASE.md)。

装本地目录版本时，改完代码**要重新装一次**（`link:` 指向目录，但 profile 里的配置是装那一刻生成的）。
