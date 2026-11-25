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

从 Release 页下载 `dsh-plan-do-0.1.0.tgz`，然后：

```bash
dsh plugin --profile <profile> add ./dsh-plan-do-0.1.0.tgz
```

或在创造模式会话里：

```text
plugin_manager action=install_bundle target=<tgz 的绝对路径>
```

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

## 6. 开发者自查（改完代码之后）

```bash
node --test                     # 395 条，必须全绿
node scripts/check-docs.mjs     # 文档与代码的交叉引用一致
node scripts/verify-pack.mjs    # 分发包清单完整（真跑 npm pack --dry-run）
node scripts/smoke-pack.mjs     # 分发包冒烟：真打包 → 解开 → 真加载 → 跑一遍流程
```

前四条都在 CI 里跑（`.github/workflows/test.yml`，ubuntu + windows 双平台）。

**发布前再加一条**（不进 CI，因为它会检查工作区干净）：

```bash
node scripts/release-check.mjs  # 元数据填全了吗、文档里还有 <owner> 吗、工作区干净吗
```

它现在**是红的**——仓库地址还没定。等你把 `<owner>` 换成真实值、补上
`repository` / `homepage` / `bugs` / `icon`，它会变绿。发布流程见 [RELEASE.md](RELEASE.md)。

装本地目录版本时，改完代码**要重新装一次**（`link:` 指向目录，但 profile 里的配置是装那一刻生成的）。
