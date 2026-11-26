# RELEASE.md：发布前要做的五件事

> 这一页是**给发布者**（你，不是装包的人）看的。装包的人看 [INSTALL.md](INSTALL.md)。
> 代码已经就位、测试全绿 + 分发清单自检过，剩下的都是「填几个值、跑几条命令」。

## 0. 先跑一次自检

```bash
node scripts/release-check.mjs
```

它逐项检查「发布准备度」并告诉你还差什么（缺元数据、git 不干净、清单不全……）。
**它不进 `node --test`**：这个仓库在开发期一直有时间戳和未提交改动，把它塞进测试只会天天红。
发布前手动跑一次，全 ✓ 再往下走。

## 1. 包名与仓库地址（已定，留档备查）

**2026-11-25 已填好**，不需要再改：

| 位置 | 值 |
|---|---|
| `package.json` 的 `name` | `dsh-plan-do`（不带 scope） |
| `package.json` 的 `repository` | `git+https://github.com/MrLiu-Mo/plan-do-mode.git` |
| `package.json` 的 `homepage` | `https://github.com/MrLiu-Mo/plan-do-mode#readme` |
| `package.json` 的 `bugs` | `https://github.com/MrLiu-Mo/plan-do-mode/issues` |
| `package.json` 的 `icon` | `./icon.svg`（与 `exports` 里那条一致，包内自描述） |
| `package.json` 的 `author` | `MrLiu-Mo <2837243604@qq.com>`（会公开显示在 npm 页面） |
| `README.md` / `PLAN.md` 的 tgz 链接 | `github.com/MrLiu-Mo/plan-do-mode` |

改完跑 `node scripts/release-check.mjs`——它会把**还指向假仓库的网址**指出来
（只提到占位符号样的说明文字不算，判据要求占位符紧挨 URL 上下文）。

> 改 `name` 会连带影响：`cordis.patch.yml` 里插件项的 `name:`、`test/preset.test.js` 的断言、
> `test/smoke-pack.test.js` 的 `meta.name` 断言、`scripts/verify-pack.mjs` 的 `requiredFiles`。
> 这四处是**故意**写死的——包名是契约的一部分，改它就该红一次测试提醒你全都改到。

> `icon` 若索引端要求绝对 URL 而不是相对路径，只改 `package.json` 的 `icon` 这一处即可
> （`files` 白名单里的 `icon.svg` 照旧要留着，它同时是包内资源）。

## 2. 确认版本号

`package.json` 的 `version` 现在是 `0.1.0`。首次发布保持它；后续每次发布改这里，
同时把 README / INSTALL 里出现的 `dsh-plan-do-0.1.0.tgz` 一起改（`release-check` 会比对）。

## 3. 四条验证全过

```bash
node --test                     # 417 条，必须全绿
node scripts/check-docs.mjs     # 文档交叉引用一致
node scripts/verify-pack.mjs    # 分发包清单完整（真跑 npm pack --dry-run）
node scripts/smoke-pack.mjs     # 真打包 → 解开 → 真加载 → 跑一遍流程
```

这四条也在 CI 里跑（`.github/workflows/test.yml`，ubuntu + windows 双平台）。
**在干净检出上跑一次**更能说明问题（`git clone` 到临时目录再跑）——本地工作区可能有未提交的改动。

## 4. 发布

### 4.1 npm（主通道，有版本号、可升级）

```bash
npm pack                      # 先看一眼产出的 .tgz 大小与内容
npm publish                   # 首次发布；需要已登录 npm（npm login）
```

零依赖 + `files` 白名单，所以包很小（约 120 kB，绝大部分是 `docs/`）。
`test/`、`scripts/`、`.github/`、`docs/REVIEW-*.md` 都**不该**进包，`verify-pack` 会拦住。

### 4.2 GitHub Release（不需要 npm 账号，国内网络更稳）

```bash
git tag v0.1.0
git push origin v0.1.0
```

然后在仓库的 Releases 页面新建 release，tag 选 `v0.1.0`，把 `npm pack` 产出的
`dsh-plan-do-0.1.0.tgz` 作为附件上传。

### 4.3 两条通道的取舍

| | npm | GitHub Release tgz |
|---|---|---|
| 需要账号 | npm 账号 | GitHub 仓库 |
| 升级 | `dsh plugin add dsh-plan-do@0.2.0` | 重新下新 tgz |
| 国内网络 | 可能慢 | 稳 |
| 索引收录 | 自动 | 需要指向 tgz URL |

两条都发不冲突，推荐都发：README 里两个入口都列着。

## 5. 发布后必须真装一次（验收 A9）

这是**唯一不能自动化**的一步：`scripts/smoke-pack.mjs` 只证明「包解开后能被 import」，
证明不了「DSH 真的把它挂进 profile 且预设列表里出现」。所以：

> **0.1.0 的第一次真装就是这么翻车的**：tgz 装上去显示「加载失败」，报
> `cannot get property "tools" without inject`。原因是 `lib/index.js` 里有
> `export default apply`——`cordis-plugin-loader` 的 `unwrapExports` 第一句是
> `exports = exports.default ?? exports`，于是整个插件被替换成那个裸函数，命名导出的
> `inject = ['tools']` 随之丢失。
>
> **为什么四条验证没拦住**：`smoke-pack.mjs` 当时直接 `mod.apply(...)`，绕过了 loader 的
> 归一化那一步——它验的是「模块能 import」，而失败发生在「loader 怎么消费这个模块」。
> 现在 `smoke-pack.mjs` 复刻了 `unwrapExports`，并断言归一化后 `inject` 还在；
> 把 `export default` 加回去它会红，报告里直接写「命名 inject 已丢失」。
>
> 教训：**冒烟脚本必须走真实加载路径，不能走一条更短的等价路径。** 短路径验的是你以为的
> 契约，不是对方的实现。

1. **开一个创造模式的会话**（普通会话里没有 `plugin_manager`）。
2. 装：
   ```text
   plugin_manager action=install_bundle target=<tgz 绝对路径>
   ```
3. `plugin_manager action=list_plugins` → 应出现 `preset-plan-do`，状态不是 `failed`。
   **看到 `failed` 就是加载阶段炸了**，最常见的就是上面那条 `without inject`。
4. **新开一个会话**，预设选择器里应出现 **「边学边做」**（id `plan-do`，排序 25）。
5. 选中它，让模型调 `plando_status` → 它应该说「还没有项目，先 plando_project init 或 plando_idea add」。
6. 按 [INSTALL.md](INSTALL.md) §4 的冒烟清单逐条打勾（重点是「守卫真的在拦写工具」）。
7. 卸载：`plugin_manager action=remove_bundle target=dsh-plan-do`。
8. 再开新会话 → 「边学边做」应消失；`~/.plando/` 与各项目的 `.plando/` **必须还在**。

第 8 步是这条验收真正的重点：**卸载不删用户数据**。如果 `.plando/` 跟着没了，那是发布阻塞级的问题。

## 6. 可选：进市场索引（不是 v1 验收项）

`awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，需要：

- 双语描述（`description.zh` / `description.en`）：说清「这是什么模式、和别的模式差在哪」。
- **主动披露 capabilities**：本包会被扫描出 `shell`（`plando_check` 执行命令）与
  `fs-write`（`plando_scaffold`、写 `.plando/`），README §能力说明已经写了，别删。
- 索引靠 `keywords` 里的 `dsh-plugin` / `dsh-bundle` 发现，别改掉。

## 附：发布前检查表（打印出来用）

- [ ] `node scripts/release-check.mjs` 全 ✓（第 1 节那些值已填好，这一步只需工作区干净）
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` / `icon` / `author` 都是真值，没有占位网址
- [ ] README 与 PLAN 里的 tgz 链接指向真实仓库
- [ ] `node --test` 全绿（干净检出上再跑一次）
- [ ] `check-docs` / `verify-pack` / `smoke-pack` 全过
- [ ] `git status` 干净，`git log` 里每个 commit 都对得上改动
- [ ] `npm pack` 产出的 tgz 里没有 `test/` / `scripts/` / `REVIEW-*.md`
- [ ] 创造模式会话里装一次、新开会话看到「边学边做」
- [ ] 卸载后预设消失、`~/.plando` 保留（**这条最容易漏**）
