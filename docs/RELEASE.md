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

## 1. 定包名与仓库地址（唯一必须你亲手改的一处）

当前是占位：

| 位置 | 现在 | 要改成 |
|---|---|---|
| `package.json` 的 `name` | `dsh-plan-do` | 若用 npm scope，改成 `@you/dsh-plan-do` |
| `package.json` 的 `repository` / `homepage` / `bugs` | **缺** | 建好仓库后补上 |
| `README.md` 第 33 行附近的 tgz 链接 | `github.com/<owner>/plan-do-mode` | 真实 `owner/repo` |
| `PLAN.md` §10.1 的同一处 | 同上 | 同上 |

改完跑 `node scripts/release-check.mjs`，它会把还含 `<owner>` 的地方指出来。

> 改 `name` 会连带影响：`cordis.patch.yml` 里插件项的 `name:`、`test/preset.test.js` 的断言、
> `test/smoke-pack.test.js` 的 `meta.name` 断言、`scripts/verify-pack.mjs` 的 `requiredFiles`。
> 这四处是**故意**写死的——包名是契约的一部分，改它就该红一次测试提醒你全都改到。

## 2. 确认版本号

`package.json` 的 `version` 现在是 `0.1.0`。首次发布保持它；后续每次发布改这里，
同时把 README / INSTALL 里出现的 `dsh-plan-do-0.1.0.tgz` 一起改（`release-check` 会比对）。

## 3. 四条验证全过

```bash
node --test                     # 378 条，必须全绿
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

1. **开一个创造模式的会话**（普通会话里没有 `plugin_manager`）。
2. 装：
   ```text
   plugin_manager action=install_bundle target=<tgz 绝对路径>
   ```
3. `plugin_manager action=list_plugins` → 应出现 `preset-plan-do`，状态不是 `failed`。
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

- [ ] `node scripts/release-check.mjs` 全 ✓
- [ ] `name` / `repository` / `homepage` / `bugs` / `icon` 都已填真值，没有 `<owner>`
- [ ] README 与 PLAN 里的 tgz 链接指向真实仓库
- [ ] `node --test` 全绿（干净检出上再跑一次）
- [ ] `check-docs` / `verify-pack` / `smoke-pack` 全过
- [ ] `git status` 干净，`git log` 里每个 commit 都对得上改动
- [ ] `npm pack` 产出的 tgz 里没有 `test/` / `scripts/` / `REVIEW-*.md`
- [ ] 创造模式会话里装一次、新开会话看到「边学边做」
- [ ] 卸载后预设消失、`~/.plando` 保留（**这条最容易漏**）
