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

/** `npm run <script>` 里允许的脚本名（与 scaffold 的 SAFE_SCRIPT_KEYS 一致）。 */
const PM_SAFE_SCRIPTS = Object.freeze([
  'test', 'tests', 'lint', 'build', 'dev', 'start', 'typecheck', 'check', 'format',
  'test:unit', 'test:e2e', 'vitest', 'jest',
]);

/** npx / pnpm / npm 里可以直接跑、且不会下载任意包的本地工具。 */
const KNOWN_TOOLS = Object.freeze(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'vite', 'ruff', 'mypy', 'black', 'pre-commit']);

/** npx 只放行 KNOWN_TOOLS（`npx <任意包>` 等于下载并执行任意代码）。 */

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
 * 三道闸：可执行文件在白名单里、argv[0] 是裸名字（不带路径）、危险参数不出现。
 * 返回 null 表示放行，否则返回人话理由（不含 plando 外壳，由调用方包装）。
 */
export function validateCommand(command) {
  const argv = tokenize(command);
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
    // `pnpm vitest run` / `pnpm tsc` 是跑**本地已装**的工具，不下载东西，放行。
    if (KNOWN_TOOLS.includes(bare)) {
      // 落到下面的通用开关检查（比如 `pnpm vitest --eval` 这种不存在的组合无害）。
    } else if (!PM_SAFE_VERBS.includes(verb)) {
      return `「${base} ${verb || '（没给子命令）'}」不是跑脚本的形式——用 ${base} test 或 ${base} run <script>`;
    } else if (verb === 'run' || verb === 'run-script') {
      const script = args.slice(idx + 1).find((token) => !String(token).startsWith('-'));
      if (script !== undefined && !PM_SAFE_SCRIPTS.includes(String(script))) {
        return `脚本名「${script}」不在允许的清单里（只有 test / build / lint 这类）`;
      }
    }
  }
  // npx 默认就是「拉一个包然后执行」，等于任意代码执行；只放行已知的本地工具。
  if (base === 'npx') {
    const known = argv.slice(1).find((token) => !String(token).startsWith('-'));
    if (!known || !KNOWN_TOOLS.includes(String(known).replace(/@.*$/, ''))) {
      return `「npx ${known || '…'}」会下载并执行任意包——直接用本地已装的工具（如 node --test）`;
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

/** 从 card（对象或 id 字符串）取出卡 id。 */
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
    return { ok: false, ...base, reason: reason(`检查 ${name} 退出码 ${base.exitCode}`, '看 stderr 修到退出码 0，再作为 done 的证据') };
  }
  return { ok: true, ...base };
}
