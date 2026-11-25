// lib/checks.js
// 卡片检查命令：声明（写 .plando/checks.json）与执行（只跑已声明的命令）。
// 契约来源：PLAN §3/§四（plando_check 只运行已声明命令）、docs/CONTRACT.md §5（错误消息形状）。
// 硬约束：
//   - 零依赖：只 import node: 内置模块。
//   - 只运行 checks.json 里已声明的命令；未声明一律拒绝，绝不执行。
//   - spawnSync + shell:false（命令不经过 shell 解析，`;` `&&` 之类不会被执行）。
//   - 写 checks.json 走 .tmp + rename 原子替换（CONTRACT §4 的写盘规则）。
//   - stdout/stderr 各截断到 8KB，避免把整页日志塞回模型上下文。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 命令长度上限（字符数）。 */
export const MAX_COMMAND_LENGTH = 500;
/** 单条输出（stdout / stderr 各算）的截断上限。 */
export const MAX_OUTPUT_BYTES = 8 * 1024;
/** 检查命令默认超时：60 秒（PLAN §四）。 */
export const CHECK_TIMEOUT_MS = 60 * 1000;

/**
 * 允许被声明为「检查命令」的可执行文件（不带扩展名，比较时统一小写）。
 * 这是一道**白名单**，不是黑名单：不在名单里的一律拒绝，
 * 这样 `cmd` / `powershell` / `curl` / 任意 exe 都进不来，
 * 不用去猜哪些 shell 有副作用（REVIEW-tools G1）。
 */
export const ALLOWED_COMMANDS = Object.freeze([
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'py', 'pytest', 'pip',
  'cargo', 'go', 'dotnet', 'java', 'mvn', 'gradle',
  'deno', 'bun', 'tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier',
  'ruff', 'mypy', 'black', 'uv',
  // 构建 / 开发服务器：它们的共同点是「跑用户项目里已经装好的依赖」，不下载、不 eval，
  // 风险和 vitest / jest 同级。不加这一批，Vite / Next / CRA 项目的标准 package.json 就写不进去
  // （REVIEW-tools §9.6.2：`vite build` 被拒而 `npx vite build` 放行，等于把白名单教成谜题）。
  'vite', 'next', 'react-scripts', 'webpack', 'rollup', 'esbuild', 'parcel',
  'nodemon', 'pm2', 'tsx', 'ts-node', 'serve',
]);

/**
 * 危险参数：这些一出现就等于把「跑一个检查」变成「执行任意代码」，
 * 于是白名单里的 node / python 也照样能写文件。一律拒（REVIEW-tools G1）。
 *
 * 注意必须连**贴值形式**一起拦：`--eval=1+1`、`-e1+1`、`--require=./x.cjs` 都是
 * 合法 node 参数，只比字符串相等会被轻松绕过（实测这三条都能执行任意代码）。
 * `-r` / `--require` / `--import` / `--loader` 会加载任意模块，等价于执行代码，同样拦。
 * `--test-reporter` 同样会 `require` 指定模块——参数名看着人畜无害，等价于 `--require`。
 * `--run` 直接跑 `package.json` 里的任意脚本，绕开 scripts 键白名单。
 */
const INTERPRETER_DENY_FLAGS = Object.freeze([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader',
  '--experimental-loader', '--run',
  '--experimental-test-reporter', '-c', '-Command', '-EncodedCommand', '/c', '/k',
]);

/**
 * 带值的开关里，有一类「值是一个模块路径」的等价于 `--require`；但同一个开关也接受
 * **内置名字**，那是完全正常的用法。笼统地拒掉会误杀 `node --test --test-reporter=spec`
 * 这种最常见的写法，并告诉用户「这会执行任意代码」——假警报比漏报更容易让人不信这套校验
 * （REVIEW-tools §9.4 N15）。
 *
 * 规则：值必须在白名单里；含路径分隔符 / 以 . 开头 / 以 .js 结尾的一律拒（那就是模块）。
 */
const FLAGS_WITH_SAFE_VALUES = Object.freeze({
  '--test-reporter': Object.freeze(['spec', 'tap', 'dot', 'junit', 'lcov', 'github']),
});

/** 值看起来像模块路径（而不是内置名字）。 */
function looksLikeModulePath(value) {
  const text = String(value);
  return text.includes('/') || text.includes('\\') || text.startsWith('.') || /\.(c|m)?js$/i.test(text);
}

/**
 * 贴值形式要看前缀（`-e1+1`、`-r./x.cjs`、`python -c"代码"`）。
 * `-c` 只对 Python 族是内联执行（`node -c` 只是语法检查），所以按解释器分开。
 */
const GLUED_FLAGS_BY_BASE = Object.freeze({
  node: ['-e', '-p', '-r'],
  nodejs: ['-e', '-p', '-r'],
  deno: ['-e', '-p', '-r'],
  bun: ['-e', '-p', '-r'],
  tsx: ['-e', '-p', '-r'],
  'ts-node': ['-e', '-p', '-r'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
});

/** 解释器：只有它们有「内联执行」这个概念。 */
const INTERPRETERS = Object.freeze(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'py', 'tsx', 'ts-node']);

/**
 * 包管理器：安装 / 执行任意包都能跑代码，所以只放行「跑脚本」这一种形态。
 * `npm exec` / `npx <任意包>` / `pnpm dlx` / `npm install` 全拒（REVIEW-tools §8）。
 */
const PACKAGE_MANAGERS = Object.freeze(['npm', 'pnpm', 'yarn']);

/**
 * 「子命令本身就是执行代码」的工具：`cargo run` / `go run` / `pip install`（会跑 setup.py）
 * 放进「检查命令」白名单等于把白名单变成摆设（REVIEW-tools §8.7 ④）。
 */
const RUN_SUBCOMMANDS = Object.freeze({
  pip: ['install', 'download', 'wheel'],
  cargo: ['run', 'install', 'script', 'bench'],
  go: ['run', 'generate', 'install', 'get'],
  dotnet: ['run', 'install', 'tool'],
  mvn: ['exec', 'run'],
  gradle: ['run', 'exec'],
  uv: ['pip', 'run', 'add'],
});

/** `java -jar x.jar` 等于「执行这个 jar」，和跑检查无关。 */
const RUN_FLAGS = Object.freeze({ java: ['-jar', '--jar'] });

/**
 * `python -m <模块>`：模块本身就是程序入口，`python -m pip install .` 会跑 setup.py。
 * 只放行这些「跑检查」的模块，其余一律拒（白名单，不猜）。
 */
const SAFE_PY_MODULES = Object.freeze([
  'pytest', 'unittest', 'mypy', 'ruff', 'black', 'doctest', 'compileall', 'json.tool', 'venv', 'coverage', 'tox',
]);

/** 包管理器允许的子命令：跑测试或跑白名单里那些脚本键。 */
const PM_SAFE_VERBS = Object.freeze(['test', 't', 'start', 'run', 'run-script']);

/**
 * `npm run <script>` 里允许的脚本名（与 scaffold 的脚本键白名单一致）。
 *
 * 判据和 scaffold.js 那边**同一套**（§16：那层报 3/24 假杀，改成「小名单 + 冒号命名空间」）：
 *   1. 没有冒号的键必须在这张名单里——npm 的生命周期钩子就是「任意名字」，只能枚举；
 *   2. 带冒号的键（`build:prod` / `test:unit`）只要求冒号前是名单里的基名。
 *      能结构化是因为**生命周期钩子里没有一个带冒号**。
 *
 * 两边各写一份是刻意的（checks 是最底层模块，不该 import scaffold；scaffold 也不该 import
 * checks——它靠 tools 注入 validateCommand）。所以漂移由 `test/scaffold.test.js` 里那条
 * **行为级**漂移断言盯着：`npm run <键>` 与 `plando_scaffold` 写同一个键必须同结论。
 */
const PM_SAFE_SCRIPTS = Object.freeze([
  'test', 'tests', 'lint', 'build', 'dev', 'start', 'typecheck', 'check', 'format',
  'preview', 'clean', 'serve', 'docs', 'e2e', 'storybook', 'analyze',
]);

/** `<基名>:<后缀>`：与 scaffold 的 SCRIPT_KEY_NAMESPACE 逐字一致。 */
const SCRIPT_KEY_NAMESPACE = /^([a-z][a-z0-9-]*):[a-z0-9:_-]+$/;

/** 脚本键是否安全：名单内的键，或「名单内的基名 + 冒号命名空间」。 */
function isSafeScriptKey(key) {
  const text = String(key ?? '');
  if (text === '') return false;
  if (PM_SAFE_SCRIPTS.includes(text)) return true;
  const namespaced = SCRIPT_KEY_NAMESPACE.exec(text);
  return !!namespaced && PM_SAFE_SCRIPTS.includes(namespaced[1]);
}

/** `pnpm vitest run` 这类「包管理器直接调本地工具」还认的名单（npx 已不再用它）。 */
const KNOWN_TOOLS = Object.freeze(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'vite', 'ruff', 'mypy', 'black', 'pre-commit']);

/** deno / bun 用子命令而不是参数执行代码：`deno eval`、`bun run -e` 之类。 */
const DANGEROUS_SUBCOMMANDS = Object.freeze(['eval', 'run-eval']);

const DANGEROUS_COMMAND_NAMES = Object.freeze(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash', 'zsh', 'csh']);

const CHECKS_FILE = 'checks.json';

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`。
// 检查命令在 build 与 ship 两个阶段都能跑，所以这里**不写死阶段名**——
// 写死「边做边学」会让收尾阶段的报错说错自己在哪（REVIEW-tools M6）。
// 需要阶段名时由 tools.js 在自己的 reason 里补。
function reason(why, next) {
  const head = '';
  const tail = `——下一步：${next}`;
  // 'plando：' 是 7 个字符（六字母 + 全角冒号），写成 6 会让上界变成 161。
  const budget = 160 - [...'plando：'].length - [...head].length - [...tail].length;
  const chars = [...String(why)];
  const whyText = chars.length <= budget ? String(why) : chars.slice(0, Math.max(budget - 1, 0)).join('') + '。';
  return `plando：${head}${whyText}${tail}`;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** checks.json 的绝对路径：<dir>/.plando/checks.json。 */
export function checksPath(dir) {
  return path.join(path.resolve(dir), '.plando', CHECKS_FILE);
}

// 原子写 JSON：先写 <file>.tmp 再 rename 覆盖，半写文件比报错更糟。
function atomicWriteJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** readChecks(dir) -> object；文件不存在返回 {}。JSON 损坏时抛 plando 形状的错误。 */
export function readChecks(dir) {
  const file = checksPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(reason(`checks.json 不是合法 JSON（${err.message}）`, '备份该文件后人工修回，或删掉它重新用 plando_card 声明检查'));
  }
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * 声明与执行共用的命令校验（REVIEW-tools G1）。
 *
 * 闸门顺序就是执行顺序，越靠前越「对任何命令都成立」：
 *   0. **`npx` 先剥壳再判一次**（R5）——npx 只是「找到这个包并执行」，它不改变后面 argv 的
 *      危险程度；把 npx 当白名单项单独放行，等于给任意命令加一个洗白前缀；
 *   1. 可执行文件在白名单里，且 argv[0] 是裸名字（不带路径）；
 *   2. **写文件开关整类拒**、**读文件开关只许项目内相对路径**（N19 / R2）——
 *      这两类不执行代码，所以后面几道一道都盖不到，必须单独收；
 *   3. 子命令形态的代码执行（`cargo run` / `pip install` / `java -jar` / `deno eval`）；
 *   4. 包管理器只许跑脚本；
 *   5. 解释器的内联执行与加载任意模块（含贴值形式）。
 *
 * 返回 null 表示放行，否则返回人话理由（不含 plando 外壳，由调用方包装）。
 */
export function validateCommand(command) {
  return validateArgv(tokenize(command), 0);
}

/**
 * 一条 token 里的「路径值」是否越出了项目（REVIEW-tools §14 R6 / §16 R9）。
 *
 * 判的是**形状**不是开关名——`--prefix` / `--cache` / `--outDir` / `-X pycache_prefix` /
 * 裸参数 `node --test ../x.js` 全都走同一条规则，所以不用为每个工具维护开关表
 * （review 实测这类开关有 20 类，列表永远补不全）。
 *
 * 命中条件（任一条）：
 *   - 值本身是绝对路径（`/x`、`\x`、`C:\x`、`C:/x`）或 UNC（`\\server\share`）；
 *   - **盘符相对路径**（`C:evil.js`、`c:..\..\x.js`、`C:dist`）——§16 R9；
 *   - 短开关贴值后跟 `..`（`-p../tsconfig.json`）——§16 R9；
 *   - 把值里的 `.` / `..` 归一化之后，**深度掉到 0 以下**（真的走出去了）；
 *   - 值里带 `=` 时，**每一段**再独立走一遍深度判定（`--prefix=a=../x`、`--outDir==../x`）——§16 R9-b。
 *
 * 注意「归一化后判断」不是「出现过 `..` 就拒」：
 * `src/../src/app.js` 归一化是 `src/app.js`，还在项目里，应当放行；
 * `../x` 归一化后深度是 -1，拒；`sub/../../evil.js` 是 -1，拒。
 * 早先按「任一段是 `..`」判，把 `src/../src/app.js` 这种合法写法误杀了。
 *
 * 盘符为什么分「绝对」和「相对」两档：`^[A-Za-z]:` 一把抓会误杀
 * `--test-name-pattern=a:b` 这种**参数值**里带冒号的合法写法（§15 踩过）。
 * 所以相对盘符要求「盘符之后出现 `.` 或分隔符」，才认它是路径。
 * 这一条是 §16 R9 复查后加的：`c:..\..\x.js` 里的 `..\..` 从任何目录都能往上退，
 * 不需要攻击者知道盘符的当前目录，所以不能按「不可利用」放宽。
 *
 * 不命中（常见合法写法，不能被误杀）：`./dist`、`src/app.js`、`go test ./...`、
 * `tsc -p tsconfig.json`、`--test-reporter=spec`、`--outDir=dist`、`--test-name-pattern=a:b`。
 * 返回命中的那个 token（用于报错），没命中返回空串。
 */
function unsafePathToken(token) {
  // 取「值」那一段：`--flag=value` 取等号后；短开关贴值（`-Xfoo`）单独判，不在这里取。
  const eq = token.indexOf('=');
  const value = eq >= 0 ? token.slice(eq + 1) : token;
  if (!value) return '';
  // 盘符绝对：C:\x / C:/x / 光秃秃的 C:
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(value)) return token;
  // 盘符相对：C:evil.js / c:..\..\x.js / C:dist（§16 R9）
  if (/^[A-Za-z]:[^\\/]/.test(value)) {
    const afterDrive = value.slice(2);
    // 有 `=` 时只认「盘符之后带 . 或分隔符」的；没有 `=` 的一律当路径。
    if (eq < 0 || /[.\\/]/.test(afterDrive)) return token;
  }
  if (/^[/\\]/.test(value)) return token; // 绝对路径或 UNC
  // 短开关贴值后直接跟 `..`：`-p../tsconfig.json`、`-o../x`（§16 R9）
  // 只认两个点——`-r./x.cjs` 里的 `./` 不是越界（它是项目内的相对路径），
  // 而且那种写法本来就该被解释器那道闸门以「执行任意代码」拒掉，不该在这里改口径。
  if (/^-[A-Za-z]\.\.[\\/]/.test(token)) return token;
  if (escapesProject(value)) return token;
  // `=` 之后再出现 `=`：每一段独立走一遍（§16 R9-b：`--prefix=a=../x`）
  if (eq >= 0) {
    for (const part of value.split('=')) {
      if (part && escapesProject(part)) return token;
    }
  }
  return '';
}

/** 逐段走一遍 `..` 深度，掉到 0 以下就是走出项目根。 */
function escapesProject(value) {
  let depth = 0;
  for (const segment of String(value).split(/[\\/]/)) {
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return true; // 走出项目根了
      continue;
    }
    if (segment === '.' || segment === '') continue;
    depth += 1;
  }
  return false;
}

/** npx 最多剥几层（`npx npx npx …` 是想让递归不终止，不是真实用法）。 */
const NPX_STRIP_LIMIT = 3;

/**
 * npx 自己的「无副作用开关」。
 *
 * 这是**唯一**保留白名单的地方，理由和别处相反：这里枚举的是 npx 自身的开关，
 * 数目有界、随 npm 版本收敛；而别处枚举的是「任意命令的任意参数」，那是攻击面，补不完
 * （`--node-options` 能往目标进程注入模块、`-c` 能再套一层 shell，都属于「想不到就没拦住」）。
 * 所以默认**拒**，只放行明确无害的。
 *
 * §16 复查发现 `--no` 与 `--no-cache` 两项不合格（已删）：
 * `--no` 是 npm 的「布尔取反前缀」，它会把后面的 token 当 npm 配置吃掉
 * （`npx --no node --test` → `npm warn Unknown cli config "--test"`，node 拿到空 argv，
 * 读空 stdin 立刻退出 0）。于是「检查通过」而测试一行都没跑。
 * 教训：**名单里每一项都得有让它必须失败的测试**，不能靠读名字判「无害」——
 * `test/checks.test.js` 里那条对每个开关跑真命令的断言就是为此加的。
 */
const NPX_SAFE_FLAGS = new Set(['-y', '--yes', '--no-install', '-q', '--quiet', '-s', '--silent']);

/**
 * 「转发参数」闸门（REVIEW-tools §16 R13）。
 *
 * `npm test -- --import=./h.mjs` 里，npm 会把 `--import=./h.mjs` **转发给它跑的脚本**，
 * 而 `validateArgv` 的解释器那几道闸门都是按 `argv[0]` 判的——`argv[0]` 是 `npm`，
 * 于是一道都不跑。这就是 `npx` 洗白（R5）的**同胞兄弟**：入口程序看到的 argv
 * 不是下游程序看到的 argv。
 *
 * 修法同样是结构性的：**脚本名之后的参数，按解释器的口径再判一遍**。
 * 只扫「脚本名之后」，所以 `mocha --require ./setup.js` 这种直接写的合法用法完全不受影响。
 *
 * 注意 `npm test sub/pwn.js`（**不带** `--`）也会被转发，所以扫的是脚本名之后的**所有**开关，
 * 不只 `--` 之后的。
 */
const FORWARD_DENY_FLAGS = Object.freeze([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader',
  '--experimental-loader', '--run', '--experimental-test-reporter',
  '-c', '-command', '-encodedcommand', '/c', '/k',
]);

/** 转发参数里是否有「会让下游执行任意代码」的开关。命中返回那个 token。 */
function unsafeForwardedArg(token) {
  const lower = String(token).toLowerCase();
  const eq = lower.indexOf('=');
  const name = eq >= 0 ? lower.slice(0, eq) : lower;
  // `-r./x.cjs` / `-e1+1` 这类贴值形式
  const glued = FORWARD_DENY_FLAGS.some((flag) => flag.startsWith('-') && !flag.startsWith('--')
    && lower.startsWith(flag) && lower.length > flag.length);
  if (FORWARD_DENY_FLAGS.includes(name) || glued) return token;
  // `--test-reporter=<模块路径>` 与解释器那边同口径：只认内置名字
  if (name === '--test-reporter') {
    const value = String(token).slice(token.indexOf('=') + 1);
    const safe = FLAGS_WITH_SAFE_VALUES['--test-reporter'];
    if (!safe.includes(value) || looksLikeModulePath(value)) return token;
  }
  return '';
}

function validateArgv(argv, depth) {
  if (argv.length === 0) return '命令解析不出可执行文件';
  const raw0 = argv[0];
  if (/[\\/]/.test(raw0)) {
    return `「${raw0}」带了路径，只接受直接写命令名（如 node、npm）`;
  }
  const base = raw0.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (DANGEROUS_COMMAND_NAMES.includes(base)) {
    return `「${raw0}」是 shell，检查命令不允许调 shell——写具体那一条检查（如 node --test）`;
  }
  if (!ALLOWED_COMMANDS.includes(base)) {
    return `「${raw0}」不在允许的检查命令里（只认 node / npm / pnpm / python / cargo 这类构建与测试工具）`;
  }

  // ── 0. npx 剥壳（REVIEW-tools §14 R5 的正修法）──────────────────────────
  //
  // 曾经这里做的是「`npx <包>` 里那个包名在不在名单里」。那个判法有两个洞：
  //   ① 后面的 argv 完全不看 → `npx node -e "…"` 放行，而 `node -e "…"` 被拒，
  //      于是 npx 变成**通用洗白前缀**（36 工具 × 10 危险参数 = 360 组全放行）；
  //   ② `npx vitest@npm:cowsay` 靠 `replace(/@.*$/,'')` 取到 `vitest`，真跑的是 cowsay。
  // 现在改成结构性的写法：**剥掉 npx 自己的包装，把剩下的 argv 当成一条独立命令重判一次**。
  // 这样「npx 后面能写什么」永远等于「命令行里能写什么」，不会再漂移。
  if (base === 'npx') {
    if (depth >= NPX_STRIP_LIMIT) {
      return '「npx」套了太多层——直接写要跑的那条命令（如 node --test）';
    }
    // npx 自己的开关也要过一遍，而且**只放行确实无副作用的几个**。
    //
    // 这里可以列名单，因为枚举的不是攻击面而是 npx 自身的开关（数目有界、随 npm 版本收敛），
    // 和「枚举任意命令参数」不是一回事。反过来，用「`-` 开头就跳过」这种宽松写法会漏掉
    // `--node-options="--require ./x.cjs"`（往目标进程注入模块）和 `-c "<整条命令>"`（再包一层 shell）。
    //
    // `-p` / `--package` 直接拒：它会让 npx **额外安装一个包**，而那个包名跟后面要跑的命令无关，
    // 剥壳逻辑根本看不到它——`npx --package evil -- node --test` 会真的把 evil 装上并跑它的 postinstall。
    let i = 1;
    while (i < argv.length) {
      const raw = String(argv[i]);
      if (raw === '--') {
        i += 1;
        break;
      }
      if (!raw.startsWith('-')) break;
      const lower = raw.toLowerCase();
      const eq = lower.indexOf('=');
      const name = eq >= 0 ? lower.slice(0, eq) : lower;
      if (name === '-p' || name === '--package') {
        return '「npx --package」会额外安装一个包（那个包名跟要跑的命令无关），不允许——直接写要跑的命令';
      }
      if (NPX_SAFE_FLAGS.has(name) && eq < 0) {
        i += 1;
        continue;
      }
      return `「npx」的「${name}」开关会改变它实际执行的东西，不允许——去掉它，直接写要跑的命令（如 node --test）`;
    }
    const rest = argv.slice(i);
    if (rest.length === 0) {
      return '「npx」后面没写要执行的命令——直接写要跑的那条命令（如 node --test）';
    }
    // 关于「光秃秃的 `npx <工具>`」（§16.8(2) 建议拒）：**没有采纳**。
    //
    // 那条建议的依据是 `npx vitest` 会进交互式 watch、在守卫里挂满 60 秒超时。这个事实成立，
    // 但「watch 挂满超时」的后果是**按失败处理**（超时不是通过），不构成绕过；
    // 而代价是实打实的误杀：`npx jest` / `npx webpack` 是标准写法（npx 先找本地的
    // `node_modules/.bin/`，本地装了就不下载），而且 `npx jest` 的默认行为就是跑一遍测试。
    // 要区分「bare 会进 watch」的那些工具，就得再列一份名单——正是三轮里反复翻车的那种修法。
    // 记进 README 的「已知残余」：bare npx 会挂满超时，写成 `npx <工具> <子命令>` 更好。
    // `@` 后面只许版本号：`pkg@1.2.3` 可以，`pkg@npm:other` 是**别名**，会去下载另一个包。
    const pkg = String(rest[0]);
    const at = pkg.indexOf('@', pkg.startsWith('@') ? 1 : 0);
    if (at >= 0) {
      const spec = pkg.slice(at + 1);
      if (!/^[\w.^~*<>=| -]+$/.test(spec) || /:/i.test(spec)) {
        return `「npx ${pkg}」用了包别名（@ 后面不是版本号）——直接写要跑的命令`;
      }
    }
    const bareName = pkg.slice(0, at >= 0 ? at : pkg.length);
    if (!bareName) {
      return '「npx」后面没写要执行的命令——直接写要跑的那条命令（如 node --test）';
    }
    // 剥掉包名，剩下的当参数；整条重判。
    return validateArgv([bareName, ...rest.slice(1)], depth + 1);
  }

  // 写文件开关：整类拒绝（N19）。放在最前面，因为它对**所有**命令都成立，
  // 不只对解释器——`npm test -- --test-reporter-destination=…` 一样能把报告写到项目外。
  // 报错里只写开关名、不回显整个 token：路径一长就会把真正的理由挤出 160 字预算。
  for (let i = 1; i < argv.length; i++) {
    const flag = writeFileFlagName(argv[i]) || unsafeReadFlagValue(argv[i]);
    if (flag) {
      const isWrite = WRITE_FILE_FLAGS.includes(flag);
      return isWrite
        ? `「${flag}」能把报告写到命令里指定的路径（等于任意文件写），不允许——让它走 stdout 就好`
        : `「${flag}」只能读项目内的相对路径（如 .env），项目外的不允许`;
    }
  }
  // 路径类参数（REVIEW-tools §14 R6）：`--prefix=<项目外>`、`--cache=<外>`、
  // `python -X pycache_prefix=<外>`、`node --test <项目外文件>` 都能把检查变成
  // 「在项目外读 / 写 / 执行」。这类开关**每个工具一张表**是列不完的（review 列了 20 类），
  // 所以按**值的形状**判：只要一个 token 的值看起来是路径，就套用和 `--env-file` 同一条规则
  // ——必须是项目内的相对路径。绝对路径 / 盘符 / UNC / 任何一段是 `..` 一律拒。
  //
  // 为什么不会误杀常见写法：`tsc -p tsconfig.json`（不带分隔符，不算路径）、
  // `vite build --outDir ./dist`（相对、无 `..`）、`go test ./...`（`...` 不是 `..`）都放行。
  for (let i = 1; i < argv.length; i++) {
    const badPath = unsafePathToken(String(argv[i]));
    if (badPath) {
      return `「${badPath}」指向项目外——检查命令只在项目内读写，路径要写成项目内的相对路径`;
    }
  }
  // 子命令形式的内联执行：`deno eval '...'`。
  if (argv.length > 1 && DANGEROUS_SUBCOMMANDS.includes(String(argv[1]).toLowerCase())) {
    return `命令里的「${argv[1]}」会让检查变成执行任意代码，不允许`;
  }
  // 「run / install」本身就是执行代码的工具：`cargo run`、`go run`、`pip install`（跑 setup.py）。
  // Maven/Gradle 写成 `exec:java`、`gradle run`，所以也要按「动词 + 冒号」匹配。
  const unsafeVerb = RUN_SUBCOMMANDS[base];
  if (unsafeVerb && argv.length > 1) {
    const verb = String(argv[1]).toLowerCase();
    const head = verb.split(':')[0];
    if (unsafeVerb.includes(verb) || unsafeVerb.includes(head)) {
      return `「${base} ${argv[1]}」会执行/安装代码（不是跑检查），不允许——用 ${base} test 这类只跑测试的子命令`;
    }
  }
  // java 只跑测试：`java -jar` 是执行任意 jar。
  const unsafeFlag = RUN_FLAGS[base];
  if (unsafeFlag) {
    for (let i = 1; i < argv.length; i++) {
      if (unsafeFlag.includes(String(argv[i]).toLowerCase())) {
        return `「${base} ${argv[i]}」会执行任意 jar，不允许——用 java 的测试框架跑检查`;
      }
    }
  }
  // 包管理器只放行「跑脚本」：`npm exec evil` / `npx evil` / `npm install` 都能执行任意代码。
  if (PACKAGE_MANAGERS.includes(base)) {
    const args = argv.slice(1);
    // 先跳过普通开关（`--silent`、`--if-present` 这些不影响「跑什么」）。
    const idx = args.findIndex((token) => !String(token).startsWith('-'));
    const verb = idx >= 0 ? String(args[idx]) : '';
    // `npm --version` 这类「只问版本」的调用无害，放行。
    if (args.length > 0 && args.every((token) => ['-v', '--version', '-h', '--help'].includes(String(token).toLowerCase()))) {
      return null;
    }
    const bare = verb.replace(/@.*$/, '');
    if (verb === 'install' || verb === 'i' || verb === 'ci' || verb === 'add' || verb === 'exec' || verb === 'x' || verb === 'dlx') {
      return `「${base} ${verb}」会安装或执行任意包，检查命令只允许跑测试与构建脚本`;
    }
    // 转发参数闸门（REVIEW-tools §16 R13）：脚本名之后的参数会被包管理器**转发**给它跑的
    // 下游程序，而上面那些解释器闸门全部按 `argv[0]` 判，`argv[0]` 是 npm 就一道都不跑。
    // 所以这里把「脚本名之后」的参数按解释器的口径再判一遍。
    // 注意 `npm test sub/pwn.js`（不带 `--`）也会被转发，所以扫的是脚本名之后的**所有** token。
    if (idx >= 0) {
      for (let i = idx + 1; i < args.length; i++) {
        const forwarded = unsafeForwardedArg(args[i]);
        if (forwarded) {
          return `「${forwarded}」会在脚本里被执行（包管理器会把参数转发过去），会让检查变成执行任意代码，不允许`;
        }
      }
    }
    // `pnpm vitest run` / `pnpm tsc` 是跑**本地已装**的工具，不下载东西，放行。
    if (KNOWN_TOOLS.includes(bare)) {
      // 落到下面的通用开关检查（比如 `pnpm vitest --eval` 这种不存在的组合无害）。
    } else if (!PM_SAFE_VERBS.includes(verb)) {
      return `「${base} ${verb || '（没给子命令）'}」不是跑脚本的形式——用 ${base} test 或 ${base} run <script>`;
    } else if (verb === 'run' || verb === 'run-script') {
      const script = args.slice(idx + 1).find((token) => !String(token).startsWith('-'));
      if (script !== undefined && !isSafeScriptKey(script)) {
        return `脚本名「${script}」不在允许的清单里（只有 test / build / lint 这类，或 <这些键>:<后缀>）`;
      }
    }
  }
  // `python -m <模块>`：模块本身是入口，只放行跑检查的那几个。
  if ((base === 'python' || base === 'python3' || base === 'py') && argv.length > 2 && String(argv[1]).toLowerCase() === '-m') {
    const mod = String(argv[2]).toLowerCase();
    if (!SAFE_PY_MODULES.includes(mod)) {
      return `「${base} -m ${argv[2]}」会执行任意模块（不是跑检查），不允许——用 python -m pytest 这类`;
    }
  }
  // 解释器：内联执行与加载任意模块一律拒，**包括贴值形式**（`-e1+1`、`--eval=…`、`-r./x.cjs`）。
  if (INTERPRETERS.includes(base)) {
    // `-c` 只对 Python 族是内联执行（`node -c` 只是语法检查）；`-e`/`-p`/`-r` 只对 JS 族危险。
    const gluedPrefixes = GLUED_FLAGS_BY_BASE[base] || [];
    for (let i = 1; i < argv.length; i++) {
      const token = String(argv[i]);
      const lower = token.toLowerCase();

      // 先放过「带白名单值」的开关：`--test-reporter=spec` 是合法用法（N15）。
      const safeFlag = Object.keys(FLAGS_WITH_SAFE_VALUES).find((flag) => lower.startsWith(`${flag}=`));
      if (safeFlag) {
        const value = token.slice(safeFlag.length + 1);
        if (FLAGS_WITH_SAFE_VALUES[safeFlag].includes(value) && !looksLikeModulePath(value)) continue;
        return `「${token}」指定了报告器模块，只有内置名字（${FLAGS_WITH_SAFE_VALUES[safeFlag].join(' / ')}）允许`;
      }
      // 分离形式：`--test-reporter spec`。
      if (FLAGS_WITH_SAFE_VALUES[lower] && i + 1 < argv.length) {
        const value = String(argv[i + 1]);
        if (FLAGS_WITH_SAFE_VALUES[lower].includes(value) && !looksLikeModulePath(value)) {
          i += 1;
          continue;
        }
        return `「${lower} ${value}」指定了报告器模块，只有内置名字（${FLAGS_WITH_SAFE_VALUES[lower].join(' / ')}）允许`;
      }

      const exact = INTERPRETER_DENY_FLAGS.includes(lower);
      // 贴值：短开关 `-e1+1`；长开关 `--eval=…`、`--require=…`。
      const glued =
        gluedPrefixes.some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length) ||
        INTERPRETER_DENY_FLAGS.some((flag) => flag.startsWith('--') && lower.startsWith(`${flag}=`));
      if (!exact && !glued) continue;
      return `命令里的「${token}」会让检查变成执行任意代码，不允许`;
    }
  }
  // 其余工具只拦明显的内联执行开关（`--command` 之类）。
  for (let i = 1; i < argv.length; i++) {
    const lower = String(argv[i]).toLowerCase();
    if (['-command', '-encodedcommand', '--eval'].includes(lower)) {
      return `命令里的「${argv[i]}」会让检查变成执行任意代码，不允许`;
    }
  }
  return null;
}

/**
 * 「**写文件**」类开关（REVIEW-tools §9.6.3 N19）。
 *
 * 这类开关的值是一个**路径**，语义是「把某份报告写到那里」——它们不执行代码，所以
 * 「内联执行开关」那份名单一条都盖不到；但它们是**任意文件写**：
 * 路径完全由命令串决定，`spawnSync` 的 `cwd` 设在项目根，`..` 与绝对路径照样能出去。
 * 实测 `node --test --test-reporter=spec --test-reporter-destination=C:\…\NOTES.md`
 * 会把用户那份文件整份覆盖成测试输出，且不可恢复。
 *
 * 取舍：**整类拒绝**，不做「值必须在项目内」的判定。理由有两条——
 *   1. 一条检查命令没有任何合法需求去写报告文件：它的产物本来就该走 stdout（工具会截断收下）；
 *   2. 「值在不在项目内」要跟着 resolve + 符号链接 + Windows 盘符/UNC 一路判断，
 *      判错一次就是静默覆盖用户文件，而整类拒绝的代价只是「想存报告的写法得让用户自己跑」。
 * 只列 node 的；python / 其他解释器没有等价的「任意路径写」开关。
 */
const WRITE_FILE_FLAGS = Object.freeze([
  '--test-reporter-destination', // 测试报告落到指定路径 ← N19 的原凶
  '--redirect-warnings', // 警告重定向到文件
  '--diagnostic-dir', // 诊断报告目录
  '--report-directory', // 崩溃报告目录
  '--report-filename', // 崩溃报告文件名
  '--heap-prof-dir', // 堆剖析输出目录
  '--cpu-prof-dir', // CPU 剖析输出目录
  '--snapshot-blob', // 快照写到指定文件
  '--disk-cache-dir', // 磁盘缓存目录
]);

/** 一条 token 是不是「写文件开关」：精确名或 `--flag=值` 形式。命中时返回开关名。 */
function writeFileFlagName(token) {
  const lower = String(token).toLowerCase();
  return WRITE_FILE_FLAGS.find((flag) => lower === flag || lower.startsWith(`${flag}=`)) || '';
}

/**
 * 「**读文件**」类开关（REVIEW-tools §12 R2）：`--env-file=C:\Users\me\.env` 会把项目外的
 * 文件读进来，内容再经 `plando_check` 的 stdout 回到模型手里——这是 WRITE_FILE_FLAGS 的另一半。
 *
 * 这里**不做整类拒绝**，因为它有明确的合法用法：`node --env-file=.env --test` 是跑测试的
 * 正常姿势，一刀切会把最常见的写法误杀（§9.6.2 的教训）。
 * 规则改成「值必须是项目内的相对路径」：绝对路径、`..`、盘符一律拒。
 */
const READ_FILE_FLAGS = Object.freeze(['--env-file', '--env-file-if-exists']);

/** 读文件开关的值是否安全（项目内相对路径）。 */
function unsafeReadFlagValue(token) {
  const lower = String(token).toLowerCase();
  const flag = READ_FILE_FLAGS.find((name) => lower === name || lower.startsWith(`${name}=`));
  if (!flag) return null;
  const value = token.slice(token.indexOf('=') + 1);
  if (lower === flag || value === '') return flag; // 分离形式或空值：一律当不安全（下面会看到它的下一个 token 吗？没有）
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) {
    return flag;
  }
  return null;
}

/**
 * 从 card（对象或 id 字符串）取出卡 id。 */
function cardIdOf(card) {
  if (isNonEmptyString(card)) return card;
  if (isPlainObject(card) && isNonEmptyString(card.id)) return card.id;
  return '';
}

/**
 * declareCheck(dir, card, command) -> { ok, reason? }
 * 把检查命令记到 <dir>/.plando/checks.json，键为卡 id；重复声明覆盖旧命令。
 */
export function declareCheck(dir, card, command) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, reason: reason('不知道该写哪个项目目录', '先调 plando_project action=open，拿项目 dir 后再声明检查') };
  }
  const id = cardIdOf(card);
  if (!id) {
    return { ok: false, reason: reason('checks 的键必须是卡片 id', '先传卡 id（如 c1）再声明检查命令') };
  }
  if (!isNonEmptyString(command)) {
    return { ok: false, reason: reason(`卡片 ${id} 的检查命令为空`, '写一条可直接执行的命令（如 node --test）后重传') };
  }
  if ([...command].length > MAX_COMMAND_LENGTH) {
    return { ok: false, reason: reason(`检查命令超过 ${MAX_COMMAND_LENGTH} 字上限`, '把检查拆成多条短命令，或写进 package.json scripts 再调用') };
  }
  // REVIEW-tools G1：declare 是 shell 面的唯一入口，命令本身必须挡在这里，
  // 否则「只跑已声明的命令」等于「只跑 AI 自己写进来的任意命令」。
  const bad = validateCommand(command);
  if (bad) {
    return { ok: false, reason: reason(bad, '写成「可执行文件 参数…」的测试命令（如 node --test、npm test），不要用 -e / -c 这类内联执行') };
  }
  const all = readChecks(dir);
  all[id] = { command, at: new Date().toISOString() };
  atomicWriteJson(checksPath(dir), all);
  return { ok: true };
}

// 把命令字符串切成 argv：支持单引号 / 双引号 / 反斜杠转义，不做变量展开和管道。
// 这样配合 shell:false，`echo a && rm -rf /` 里的 `&&` 只会被当成普通参数。
function tokenize(command) {
  const tokens = [];
  let buf = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) buf += command[++i];
      else buf += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) tokens.push(buf);
      buf = '';
      has = false;
    } else {
      buf += ch;
      has = true;
    }
  }
  if (has) tokens.push(buf);
  return tokens;
}

// 按字节截断（不切坏多字节字符由 Buffer 处理），超长时补一句说明。
function truncate(text) {
  const str = typeof text === 'string' ? text : '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= MAX_OUTPUT_BYTES) return { text: str, truncated: false };
  return {
    text: `${buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n…（输出已截断，原长 ${buf.length} 字节，只保留前 ${MAX_OUTPUT_BYTES} 字节）`,
    truncated: true,
  };
}

/**
 * Windows 上 `npm` / `npx` / `pnpm` / `yarn` 其实是 `*.cmd` 批处理包装：
 * 直接 spawn 会 ENOENT（找不到 `npm`）或 EINVAL（`.cmd` 不能丢给 CreateProcess）。
 * 用 `shell:true` 补会重新打开 shell 注入面，所以宁可找一个**确定存在的 JS 入口**：
 * Windows 的 Node 安装器会把 npm 的入口放在 `<node.exe 所在目录>\node_modules\npm\bin\npm-cli.js`。
 * 找到就用 `node <cli> …` 跑；找不到就返回 null，由调用方给出可操作的报错。
 */
const WIN_CLI_ENTRIES = Object.freeze({
  npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  npx: ['node_modules', 'npm', 'bin', 'npx-cli.js'],
});

function resolveBinary(raw) {
  if (process.platform !== 'win32') return { command: raw, prefix: [] };
  const rel = WIN_CLI_ENTRIES[String(raw).toLowerCase()];
  if (!rel) return { command: raw, prefix: [] };
  const cli = path.join(path.dirname(process.execPath), ...rel);
  try {
    if (fs.statSync(cli).isFile()) return { command: process.execPath, prefix: [cli] };
  } catch {
    // 没装成那种布局，退回原名并在报错里说清楚
  }
  return { command: raw, prefix: [] };
}

/**
 * 最近一次检查的结果凭据：`<dir>/.plando/checks.json` 旁边再放一份 `last-check.json`。
 *
 * 为什么需要（REVIEW-tools M4）：`evidence.kind='check'` 的 summary 只是模型的自述——
 * 「跑了 npm test，退出码 0」这句话，在**从没跑过**的时候一样写得出来。
 * 所以 done 时不能只听它说，要对着「真的跑成功了什么」比对。
 *
 * 不写进 state.json 的理由：那是**状态机**的数据（要版本号、要迁移、要契约修订）；
 * 这只是「工具最近一次执行的凭据」，属于 .plando/ 下的运行记录，重启后失效也无所谓。
 */
const LAST_CHECK_FILE = 'last-check.json';

export function lastCheckPath(dir) {
  return path.join(path.resolve(dir), '.plando', LAST_CHECK_FILE);
}

/** 读最近一次凭据；没有 / 坏了都返回 null（由调用方决定当作「没跑过」）。 */
export function readLastCheck(dir) {
  try {
    const raw = fs.readFileSync(lastCheckPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 记凭据：失败不影响检查本身的返回（凭据是辅助，不是主流程）。
function writeLastCheck(dir, record) {
  try {
    atomicWriteJson(lastCheckPath(dir), record);
  } catch {
    // 写不进去最多让 done 时多拒一次，不该让检查白跑
  }
}

/**
 * runCheck(dir, name) -> { ok, exitCode, stdout, stderr, reason? }
 * name 是卡片 id（checks.json 的键）。只执行已声明的命令；未声明 → ok:false 且绝不执行。
 */
export function runCheck(dir, name) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: reason('不知道该在哪个项目目录跑检查', '先调 plando_project action=open，拿项目 dir 后再跑检查') };
  }
  let all;
  try {
    all = readChecks(dir);
  } catch (err) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: String((err && err.message) || err) };
  }
  const entry = isNonEmptyString(name) ? all[name] : undefined;
  const command = isPlainObject(entry) ? entry.command : typeof entry === 'string' ? entry : '';
  if (!isNonEmptyString(command)) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: reason(`检查 ${String(name)} 没有在 checks.json 里声明，不会执行任何命令`, '先用 plando_card 声明这张卡的检查命令（plando_check action=declare），再跑检查'),
    };
  }

  const argv = tokenize(command);
  if (argv.length === 0) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: reason(`检查 ${name} 的命令解析不出可执行文件`, '改写成「可执行文件 参数…」的形式后重新声明') };
  }
  // 执行前再验一次：checks.json 可能被手改、也可能是旧版本写进去的，
  // 声明那一刻的校验不能当作永久授权。
  const bad = validateCommand(command);
  if (bad) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: reason(`检查 ${name} 的命令不安全：${bad}`, '重新声明一条只跑测试的命令（如 node --test）'),
    };
  }
  const spawnTarget = resolveBinary(argv[0]);
  const spawnArgv = [...spawnTarget.prefix, ...argv.slice(1)];
  const result = spawnSync(spawnTarget.command, spawnArgv, {
    cwd: path.resolve(dir),
    shell: false,
    timeout: CHECK_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });

  const out = truncate(result.stdout);
  const errOut = truncate(result.stderr);
  const base = { exitCode: typeof result.status === 'number' ? result.status : null, stdout: out.text, stderr: errOut.text };

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    const why = timedOut ? `检查 ${name} 超过 ${CHECK_TIMEOUT_MS / 1000} 秒未结束` : `检查 ${name} 起不来（${result.error.message}）`;
    return { ok: false, ...base, reason: reason(why, timedOut ? '把检查改快或只跑单个测试文件后重试' : '确认命令的可执行文件已安装，并写成 `node …` 这类简单形式') };
  }
  if (base.exitCode !== 0) {
    writeLastCheck(dir, { name, command, ok: false, exitCode: base.exitCode, at: new Date().toISOString() });
    return { ok: false, ...base, reason: reason(`检查 ${name} 退出码 ${base.exitCode}`, '看 stderr 修到退出码 0，再作为 done 的证据') };
  }
  writeLastCheck(dir, { name, command, ok: true, exitCode: base.exitCode, at: new Date().toISOString() });
  return { ok: true, ...base };
}
