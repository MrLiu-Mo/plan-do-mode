// lib/scaffold.js
// 配置/脚手架白名单写入：plando_scaffold 的唯一落点（PLAN §五「不代写」的例外）。
// 契约来源：PLAN §五（守卫与「不代写」的落点）、docs/CONTRACT.md §5（错误消息形状）。
// 硬约束：
//   - 零依赖：只 import node: 内置模块。
//   - 白名单只有下面 WHITELIST 里那 7 个顶层文件名，不自作主张扩大。
//   - 还必须对应 TECH 清单里归属为 ai 的条目（techItem.owner === 'ai'）。
//   - 路径必须 resolve 后仍在项目目录内；绝对路径、`..`、符号链接逃逸一律拒。
//   - 已存在且内容完全相同 → 幂等返回 { ok:true, written:false }；内容不同 → 拒（不覆盖用户的文件）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 白名单：只放**声明式配置**，不放任何会被执行或被当成用户内容的文件。
 *
 * 这一版比 PLAN 初稿少了四项，都是有原因的（REVIEW-tools G2 / L5）：
 *   - `vite.config.js` / `vite.config.ts`：可执行 JS，写进去就能被 `node vite.config.js` 跑起来，
 *     等于绕过「不代写」开了一个任意代码入口；
 *   - `README.md` / `index.html`：这是用户的内容文件，不是配置文件，替用户写等于代写。
 * 真的需要 vite 配置时，让用户自己 `npm create vite`，或自己写。
 */
export const WHITELIST = Object.freeze([
  'package.json',
  'tsconfig.json',
  '.gitignore',
  '.env.example',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
]);

const ALLOWED = new Set(WHITELIST);

/** 单个脚手架文件的内容上限（字符数）：配置文件不会这么大。 */
export const MAX_CONTENT_CHARS = 1024 * 1024;

/**
 * package.json 里的脚本键白名单：只允许「跑测试 / 跑构建」这类，
 * 挡住 `postinstall` 之类「用户下次 npm install 时自动执行」的钩子（REVIEW-tools G2b）。
 *
 * §16 复查报了这一层 3/24 的假杀（`preview` / `clean` / `build:prod`）。加名字治不了根，
 * 所以这里分成两条规则（**结构 + 小名单**，和 §15 那条结论一致）：
 *
 *   1. **没有冒号的键**必须在上面这张小名单里。这一条必须靠枚举——npm 的生命周期钩子
 *      （`preinstall` / `postinstall` / `prepare` / `prepublishOnly` / `prepack` …）就是
 *      「任意名字」，谁也猜不出下一个；而这张名单是有界的，因为「跑检查/构建」的常用键收敛。
 *   2. **带冒号的键**（`test:unit` / `build:prod` / `dev:client` …）只要求「冒号前是名单里的基名」。
 *      这一条能结构化，因为**npm 的生命周期钩子里没有一个带冒号**——
 *      `pre*` / `post*` 前缀的都是钩子，而 `build:prod` 永远只是被显式调用的脚本。
 *      于是 `build:*` / `test:*` 这种「一个基名扩出十来个变体」的写法不用逐项补名单。
 *
 * 代价（故意的）：`prepare` / `prepublishOnly` 这类**确实是**生命周期钩子的键不会放行，
 * 哪怕它们在有些项目里只用来跑 `husky install`——装了 husky 就等于装了别的包，
 * 那本来就超出「跑检查」的范围。
 */
const SAFE_SCRIPT_KEYS = Object.freeze([
  'test', 'tests', 'lint', 'build', 'dev', 'start', 'typecheck', 'check', 'format',
  'preview', 'clean', 'serve', 'docs', 'e2e', 'storybook', 'analyze',
]);

/** `<基名>:<后缀>` 的命名空间形式；后缀只许小写字母、数字、`-`、`_`、`:`。 */
const SCRIPT_KEY_NAMESPACE = /^([a-z][a-z0-9-]*):[a-z0-9:_-]+$/;

/**
 * 脚本键是否安全（scaffold 与 checks 两边共用同一套判据）。
 *
 * 为什么导出而不是各写一份：这是「同一个命令能过 plando_check、却写不进 scripts」那类漂移的
 * 源头。`test/scaffold.test.js` 有一条漂移断言盯着两边。
 */
export function isSafeScriptKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  if (SAFE_SCRIPT_KEYS.includes(key)) return true;
  const namespaced = SCRIPT_KEY_NAMESPACE.exec(key);
  return !!namespaced && SAFE_SCRIPT_KEYS.includes(namespaced[1]);
}

/** 供报错与测试使用的只读清单。 */
export const SAFE_SCRIPT_KEY_LIST = SAFE_SCRIPT_KEYS;

/**
 * 旧的便宜过滤层：名字级黑名单。留着当第一道（在 `validateScriptValue` 里调用），
 * 但**不再**是唯一防线——它被绕过的形态已经写进 `validateScriptValue` 的注释。
 */
const SCRIPT_VALUE_DENY = Object.freeze([
  /\bnode\s+(-e|--eval|-p|--print)\b/i,
  /\bnode\s+-r\b/i,
  /\b(?:python|python3|py)\s+-c\b/i,
  /\b(?:curl|wget)\b/i,
  /\|\s*(?:sh|bash)\b/i,
  /\beval\b/i,
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\b(?:powershell|pwsh|cmd)\b/i,
]);

/**
 * `scripts` 的**值**才是真正会被执行的东西，键名合法不代表内容合法。
 *
 * 这一层原本是纯 denylist（`SCRIPT_VALUE_DENY`），被 REVIEW-tools §9.3 证明不够用：
 * `python -X utf8 -c "…"`、`npm ci && node exploit.js`、`NODE_OPTIONS=--require=… node --test`
 * 全部能过。而且因为 `plando_check` 现在真的能跑 `npm test`（Windows 上找 npm 的修复），
 * 这条链变成了「AI 自己埋命令 → AI 自己执行」，不再需要用户配合。
 *
 * 所以改成四条硬规则（拒绝优先，不做「猜」）：
 *   1. 不允许 `;` `|` 反引号 `$(` —— 管道与命令替换能把数据搬去别处、把输出当命令跑；
 *   2. 不允许环境变量前缀：`NODE_OPTIONS=… node …` 能把 node 变成加载任意模块；
 *   3. `&&` / `||` **分档**：允许串联，但**每一段**都要单独过关（都过命令名白名单 +
 *      argv 级校验）。原来见到 `&&` 就拒，把 `rimraf dist && vite build` 这种标准 build
 *      写法一起误杀了（REVIEW-tools §9.6.2）——误杀的代价是模型学着加前缀试错，比漏报更糟；
 *   4. 每一段的命令名必须在 `SCRIPT_COMMANDS` 里 —— 这样 `tar` / `./evil.sh` / `make` 也关掉。
 */
const SCRIPT_SEPARATORS = Object.freeze([';', '|', '`', '$(']);
/** 允许的串联符：分档处理，每段单独校验。 */
const SCRIPT_CHAIN = Object.freeze(['&&', '||']);

/**
 * 允许出现在 scripts 值里的命令名。
 *
 * **为什么这里要跟 `checks.ALLOWED_COMMANDS` 对齐**：两份名单一漂移，就出现「同一个命令
 * 能过 plando_check 的校验、却写不进 package.json」的情况，而 scripts 恰恰是最常写命令的地方。
 * §9.6.2 实测过这个后果：`vite build` 被第 ④ 层拒、`npx vite build` 放行，等于把白名单
 * 教成一道可试错的谜题。`test/scaffold.test.js` 里有一条**漂移断言**，两边不一致就红。
 *
 * 比 ALLOWED_COMMANDS 少了 `pip` / `uv`：装包不属于「跑脚本」，不该出现在 scripts 里。
 */
export const SCRIPT_COMMANDS = Object.freeze([
  'node', 'npm', 'pnpm', 'yarn', 'npx',
  'tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier',
  'vite', 'next', 'react-scripts', 'webpack', 'rollup', 'esbuild', 'parcel',
  'nodemon', 'pm2', 'tsx', 'ts-node', 'serve',
  'python', 'python3', 'py', 'pytest', 'ruff', 'mypy', 'black',
  'cargo', 'go', 'dotnet', 'java', 'mvn', 'gradle', 'deno', 'bun',
]);

/**
 * 「友好壳」：它们本身不执行任意代码，只是在真正的命令前面设环境变量 / 先清目录。
 * `cross-env NODE_ENV=production vite build`、`rimraf dist && vite build` 都是标准写法，
 * 一律拒掉会误伤到「这个模式连 package.json 都不会写」——而误伤的代价是模型学着换前缀试错
 * （§9.6.2 实测：`vite build` 拒、`npx vite build` 放行，等于把白名单教成谜题）。
 *
 * 只收这两种语义；`shx` / `run-s` / `concurrently` 这类**间接执行**的壳暂不收：
 * 白名单越小越不容易被绕。
 */
const SCRIPT_SHELLS = Object.freeze({
  'cross-env': 'env',
  dotenv: 'env',
  'env-cmd': 'env',
  rimraf: 'files',
});

/**
 * 会改变「加载什么代码」的环境变量名：`NODE_OPTIONS=--require=./evil.cjs node --test`
 * 等价于加载任意模块。这些名字即使在 `cross-env` 后面也不许出现。
 */
const ENV_NAME_DENY = Object.freeze([
  'node_options', 'node_path', 'node_extra_ca_certs', 'pythonpath', 'pythonstartup', 'pythonhome',
  'path', 'pathext', 'ld_preload', 'ld_library_path', 'dyld_insert_libraries',
  'bash_env', 'env', 'shell', 'comspec', 'electron_run_as_node', 'npm_config_node_options',
]);

/** 环境变量的值只允许裸字：带空格 / 引号的值会被当成命令分隔的一部分。 */
const ENV_VALUE_RE = /^[A-Za-z0-9_.:@/+~-]+$/;

/** 兜底里 `npx` 认的本地工具（`npx <未知包>` 等于下载并执行任意代码）。 */
const KNOWN_SCRIPT_TOOLS = Object.freeze(['tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'vite', 'next', 'webpack', 'rollup', 'esbuild', 'tsx', 'ts-node']);

/** 这些命令「要看参数才知道危不危险」，没有 argv 级校验时必须自己挡一道。 */
const INTERPRETER_NAMES = Object.freeze(['node', 'python', 'python3', 'py', 'deno', 'bun']);

/**
 * 兜底校验：**只在**调用方没注入 `checks.validateCommand` 时用。
 * 它不是完整校验——完整那份在 `checks.js`（tools.js 每次都会注入）。但也不能因为
 * 「反正有人会注入」就退化成空检查：那样一旦哪里漏传一个参数，这一层就静默失效了。
 *
 * 只覆盖三条最要命的、且**不需要完整白名单**就能判的规则：
 *   1. 解释器的内联执行开关（`node -e`、`python -c`）——`node --test` 与 `node -e …` 的差别
 *      全在参数里，少这一道就只剩命令名可比；
 *   2. 包管理器的安装 / 执行子命令（`npm ci`、`npx dlx`）——它们会下载并执行任意包；
 *   3. `npx <未知包>`。
 * 不做的是「命令名白名单」和「脚本名白名单」：那些要跟 `checks.ALLOWED_COMMANDS` 保持
 * 同一份事实来源，抄一份到这儿必然漂移（§9.6.2 的教训），所以只留一句注释指向那边。
 */
const FALLBACK_INTERPRETER_FLAGS = Object.freeze([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader',
  '--experimental-loader', '--run', '--experimental-test-reporter',
]);
const FALLBACK_PM_BAD_VERBS = Object.freeze(['install', 'i', 'ci', 'add', 'exec', 'x', 'dlx']);

function fallbackValidateCommand(command) {
  const tokens = String(command).split(/\s+/).filter(Boolean);
  const head = (tokens[0] || '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  const isPy = ['python', 'python3', 'py'].includes(head);

  if (INTERPRETER_NAMES.includes(head)) {
    const denyFlags = isPy ? [...FALLBACK_INTERPRETER_FLAGS, '-c'] : FALLBACK_INTERPRETER_FLAGS;
    for (let i = 1; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase();
      // `--eval=…` 这类贴值形式，以及 `-e1+1` 这类黏连形式。
      const hit = denyFlags.some((flag) => lower === flag || lower.startsWith(`${flag}=`)
        || (flag.length === 2 && !isPy && lower.startsWith(flag) && lower.length > 2));
      if (hit) return `命令里的「${tokens[i]}」会让脚本变成执行任意代码，不允许`;
    }
  }
  // 包管理器：只认跑脚本的形态，安装 / 执行子命令一律拒（与 checks.js 同口径的**子集**）。
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(head)) {
    const verb = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (verb === undefined) return null;
    const bare = String(verb).toLowerCase().replace(/@.*$/, '');
    if (FALLBACK_PM_BAD_VERBS.includes(bare)) {
      return `「${head} ${verb}」会安装或执行任意包，脚本里只允许跑测试与构建`;
    }
    if (head === 'npx' && !KNOWN_SCRIPT_TOOLS.includes(bare)) {
      return `「npx ${verb}」会下载并执行任意包，改用本地已装的工具`;
    }
  }
  return null;
}

/**
 * 把一条 `scripts` 值切成若干段，每段单独校验。
 *
 * `&&` / `||` 允许；`;` `|` 反引号 `$(` 不允许（它们能把数据搬去别处、把输出当命令跑，
 * 而合法的 build 写法几乎不需要它们）。切的时候把「引号里的」分隔符当普通字符，
 * 免得 `node -e "a && b"` 被切成两段反而看起来像正常串联。
 */
function splitScriptCommand(text) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (SCRIPT_CHAIN.includes(two)) {
      parts.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((part) => part.trim());
}

/** 单段校验：返回 null 表示这一段可以跑。 */
function validateSegment(segment, validateCommand) {
  if (segment === '') return '串联符旁边是空的，有一段的命令缺失';
  // 环境变量前缀：`NODE_OPTIONS=--require=./evil.cjs node --test`。
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(segment)) {
    return '以环境变量赋值开头（可以借此改变解释器行为）';
  }

  let rest = segment;
  // 友好壳：剥掉壳与它自己的参数，剩下的才是真正要跑的命令。
  for (let guard = 0; guard < 4; guard++) {
    const [headRaw, ...tail] = rest.split(/\s+/).filter(Boolean);
    const head = (headRaw || '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
    const shellKind = SCRIPT_SHELLS[head];
    if (!shellKind) break;

    if (shellKind === 'env') {
      // `cross-env A=1 B=2 <命令>`：壳的参数只能是 `KEY=VALUE`，且名字/值都要干净。
      let idx = 0;
      for (; idx < tail.length; idx++) {
        const token = tail[idx];
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
        const name = token.split('=')[0];
        const value = token.slice(name.length + 1);
        if (ENV_NAME_DENY.includes(name.toLowerCase())) {
          return `壳「${head}」设了 ${name}——它会改变加载行为`;
        }
        if (value !== '' && !ENV_VALUE_RE.test(value)) {
          return `壳「${head}」把 ${name} 设成了「${value}」——值里只能是字母数字与 _.:@/+~-`;
        }
      }
      if (idx === 0) return `壳「${head}」后面没有 KEY=VALUE（写法不对）`;
      if (idx >= tail.length) return `壳「${head}」后面没有要执行的命令`;
      rest = tail.slice(idx).join(' ');
      continue;
    }
    // `rimraf <路径>… <命令>`：路径只能是项目内的相对路径；路径吃掉之后就剩命令。
    // 判断「哪些是路径」的办法是从左往右收，直到碰到一个**已知命令名**为止——
    // 比猜「哪个 token 像路径」稳。
    let idx = 0;
    for (; idx < tail.length; idx++) {
      const token = tail[idx];
      const tokenBase = token.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
      if (SCRIPT_COMMANDS.includes(tokenBase) || SCRIPT_SHELLS[tokenBase]) break;
      if (token.startsWith('-')) {
        return `壳「${head}」带了开关「${token}」，脚手架只允许它清项目内的目录`;
      }
      if (path.isAbsolute(token) || token.split(/[\\/]/).includes('..')) {
        return `壳「${head}」要删的「${token}」在项目外（脚手架只清项目内的构建产物）`;
      }
    }
    if (idx === 0) return `壳「${head}」后面没有要删的路径`;
    if (idx >= tail.length) {
      // `rimraf dist && vite build`：清目录自己就是一段，链条下一段才是真正的构建命令。
      // 这类壳可以独立成段；但 `cross-env A=1` 单独一段毫无意义，所以只对 files 壳放行。
      return null;
    }
    rest = tail.slice(idx).join(' ');
    continue;
  }

  const head = rest.split(/\s+/).filter(Boolean)[0] || '';
  const base = head.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (!SCRIPT_COMMANDS.includes(base)) {
    return `以「${head}」开头，不在允许的脚本命令里（只认 node / npm / tsc / vite 这类测试与构建工具）`;
  }
  if (typeof validateCommand === 'function') {
    const bad = validateCommand(rest);
    if (bad) return `命令不合法：${bad}`;
  } else {
    const bad = fallbackValidateCommand(rest);
    if (bad) return bad;
  }
  return null;
}

/**
 * 校验 `scripts` 里的一条值。
 * @param {string} key 脚本键（只为报错时定位）
 * @param {string} value 脚本值
 * @param {(command: string) => (string|null)} [validateCommand] 由 tools.js 注入 checks.validateCommand
 * @returns {string|null} null = 放行；否则人话理由
 */
export function validateScriptValue(key, value, validateCommand) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return null;

  // 1) 管道 / 命令替换 / 分号：整条拒（合法 build 写法几乎不需要它们）。
  const separator = SCRIPT_SEPARATORS.find((sep) => text.includes(sep));
  if (separator) {
    return `scripts.${key} 里有「${separator}」，管道与命令替换能把输出当命令跑，脚手架不代写`;
  }
  // 2) 整条命令的最外层环境变量前缀（不在壳里的那种）也要拒。
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)) {
    return `scripts.${key} 以环境变量赋值开头（「${text.split('=')[0]}=…」），可以借此改变解释器行为`;
  }
  // 3) 旧的 denylist 留着当第一道便宜过滤（`node -e`、`curl`、`rm -rf` 这类）。
  if (SCRIPT_VALUE_DENY.some((re) => re.test(text))) {
    return `scripts.${key} 是「${text}」——这条命令会在跑测试时执行，脚手架不代写`;
  }

  // 4) 按 `&&` / `||` 切段，**每段**都要过关。
  //    这是 §9.6.2 的修法：原来见到 `&&` 就整条拒，误杀了 `rimraf dist && vite build`
  //    这类标准写法；分档之后串联照旧能用，但串联不能用来藏一条坏命令。
  const segments = splitScriptCommand(text);
  if (segments.length > 8) {
    return `scripts.${key} 串了 ${segments.length} 段命令，一条脚本不该这么长`;
  }
  for (const segment of segments) {
    const bad = validateSegment(segment, validateCommand);
    if (bad) {
      // 不把整段命令再回显一遍：`scripts.<键>` 已经定位到了，段落一长（`cross-env … node --test`）
      // 就会把真正的理由挤出 160 字预算，模型只能看到「壳「cross-env」设了 N。」这种半句。
      return `scripts.${key}：${bad}`;
    }
  }
  return null;
}

/**
 * 依赖的值也可能执行代码：`file:` / `link:` / `http(s):` / `git+…` 指向的包，
 * 装的时候会跑它自己的 `postinstall`（REVIEW-tools G2 的 `dependencies` 那条）。
 * 只允许普通的「名字 + 版本区间」。
 */
const DEP_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const SAFE_VERSION_RE = /^(?:[\^~<>=\s]*\d|latest$|\*$|workspace:)/i;

/** 内容校验：文件名对了不等于内容对（REVIEW-tools G2）。返回 null 表示放行，否则返回人话理由。 */
export function validateContent(rel, content, validateCommand) {
  const name = String(rel).replace(/\\/g, '/');
  if (/\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i.test(name)) {
    return `「${name}」是可执行脚本，脚手架不代写代码`;
  }
  if (name.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return `「${name}」不是合法 JSON（${(err && err.message) || ''}）`;
    }
    if (!isPlainObject(parsed)) return `「${name}」的顶层必须是对象`;
    const scripts = parsed.scripts;
    if (scripts !== undefined) {
      if (!isPlainObject(scripts)) return `「${name}」里的 scripts 必须是对象`;
      for (const key of Object.keys(scripts)) {
        if (!isSafeScriptKey(key)) {
          return `「${name}」里的 scripts.${key} 不在允许的脚本键里（${SAFE_SCRIPT_KEYS.join(' / ')}，或 <这些键>:<后缀>）——生命周期钩子（postinstall 之类）会替你执行命令`;
        }
        const value = scripts[key];
        if (typeof value !== 'string') return `「${name}」里的 scripts.${key} 必须是字符串`;
        // 值才是真正会被执行的东西。这里调 validateScriptValue（串联 / 环境变量前缀 /
        // 命令名白名单 / checks 的 argv 级校验四道），不再只跑一条正则（REVIEW-tools §9.3）。
        const badValue = validateScriptValue(key, value, validateCommand);
        if (badValue) return `「${name}」里的 ${badValue}`;
      }
    }
    for (const field of DEP_FIELDS) {
      const deps = parsed[field];
      if (deps === undefined) continue;
      if (!isPlainObject(deps)) return `「${name}」里的 ${field} 必须是对象`;
      for (const [depName, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string') return `「${name}」里的 ${field}.${depName} 必须是版本字符串`;
        if (!SAFE_VERSION_RE.test(spec.trim())) {
          return `「${name}」里的 ${field}.${depName} 是「${spec}」——只允许普通版本号（http / git / file: 指向的包安装时会跑它自己的脚本）`;
        }
      }
    }
    return null;
  }
  if (name === '.gitignore' || name === '.env.example') {
    // 纯文本，但脚本文件里出现 shebang 之类不算问题；这里只防「这不是文本」。
    return null;
  }
  if (name.endsWith('.toml') || name.endsWith('.txt')) {
    if (/^\s*#!"/m.test(content) && name.endsWith('.txt')) return `「${name}」内容不像声明式配置`;
    return null;
  }
  return null;
}

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`。
function reason(why, next) {
  const head = '现在是「边做边学」阶段，';
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

// 目标路径是否仍在 root 之内（Windows 下大小写不敏感，统一小写比较）。
function inside(root, target) {
  const a = root.toLowerCase();
  const b = target.toLowerCase();
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
}

// 逐级检查路径上已存在的组件有没有符号链接（防止 `ln -s /etc link` 那种逃逸）。
// 从已存在的最近祖先往下建，任何一段是 symlink 就拒。
function hasSymlinkOnPath(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return false;
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err && err.code === 'ENOENT') return false; // 后面还不存在，不可能有链接
      throw err;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * writeScaffold(dir, relativePath, content, techItem, options?) -> { ok, written?, reason? }
 * 只允许写白名单里的顶层配置文件，且 techItem.owner === 'ai'。
 *
 * options.validateCommand：可选，传 `checks.validateCommand` 进来做 argv 级校验。
 * scaffold 不 import checks（依赖方向是单向的：tools 同时认识两者），
 * 所以由 tools.js 注入，而不是在 scaffold 里复制一份白名单（两份必然漂移）。
 */
export function writeScaffold(dir, relativePath, content, techItem, options = {}) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, reason: reason('不知道该写哪个项目目录', '先调 plando_project action=open，拿项目 dir 后再写脚手架') };
  }
  if (!isNonEmptyString(relativePath)) {
    return { ok: false, reason: reason('relativePath 不能为空', '传白名单里的文件名（如 package.json）后重试') };
  }
  if (typeof content !== 'string') {
    return { ok: false, reason: reason('content 必须是字符串', '把要写的文件内容作为字符串传入') };
  }
  // 配置文件都是几 KB 量级；5 MB 的"配置"只会是有人拿它当文件传输通道（REVIEW-tools L4）。
  if ([...content].length > MAX_CONTENT_CHARS) {
    return { ok: false, reason: reason(`content 有 ${content.length} 字符，超过 ${MAX_CONTENT_CHARS} 上限`, '只写真正的配置文件；大文件让用户自己放进去') };
  }

  const rel = relativePath.replace(/\\/g, '/').trim();

  // 1) 路径穿越先判：绝对路径、`..` —— 这两种连白名单都不必看，直接给逃逸的理由。
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    return { ok: false, reason: reason(`「${relativePath}」是绝对路径，不允许`, '改成白名单里的相对文件名（如 package.json）后重试') };
  }
  if (rel.split('/').includes('..')) {
    return { ok: false, reason: reason(`「${relativePath}」含 ..，试图跳出项目目录`, '改成白名单里的相对文件名后重试') };
  }

  // 2) 白名单：只认精确的顶层文件名，`sub/package.json`、`src/app.js` 之类一律不在名单里。
  if (!ALLOWED.has(rel)) {
    return {
      ok: false,
      reason: reason(`「${relativePath}」不在白名单（只有 ${WHITELIST.length} 个配置文件名）`, '只写白名单里的配置文件；业务代码由你自己写'),
    };
  }

  // 3) TECH 项归属：必须明确是 ai。
  if (!isPlainObject(techItem) || techItem.owner !== 'ai') {
    return {
      ok: false,
      reason: reason(`「${rel}」对应 TECH 项归属不是 ai`, '把这件事写进 TECH 清单并标注「可交给 AI」，再传 techItem.owner=\'ai\' 后重试'),
    };
  }

  // 4) 内容校验：文件名对了不等于内容对（REVIEW-tools G2）。
  const contentBad = validateContent(rel, content, options.validateCommand);
  if (contentBad) {
    return { ok: false, reason: reason(contentBad, '只写声明式配置；可执行脚本与生命周期钩子由用户自己写') };
  }

  let rootReal;
  try {
    rootReal = path.resolve(dir);
    fs.mkdirSync(rootReal, { recursive: true });
    rootReal = fs.realpathSync(rootReal);
  } catch (err) {
    return { ok: false, reason: reason(`项目目录不可用（${err.message}）`, '确认项目 dir 存在且可写后重试') };
  }
  const target = path.resolve(rootReal, rel);
  if (!inside(rootReal, target)) {
    return { ok: false, reason: reason('目标路径不在项目目录内', '只写项目根目录下的白名单文件') };
  }
  let symlinked = false;
  try {
    symlinked = hasSymlinkOnPath(rootReal, target);
  } catch (err) {
    return { ok: false, reason: reason(`检查目标路径失败（${err.message}）`, '确认项目目录权限后重试') };
  }
  if (symlinked) {
    return { ok: false, reason: reason(`「${rel}」或它的上级目录是符号链接，可能逃逸出项目目录`, '删掉该符号链接、改用真实文件后重试') };
  }
  // 落点真实路径也必须在项目内（防目录本身是链接时 realpath 对不上）。
  const parentReal = fs.realpathSync(path.dirname(target));
  if (!inside(rootReal, path.join(parentReal, path.basename(target)))) {
    return { ok: false, reason: reason('目标路径解析后不在项目目录内', '只写项目根目录下的白名单文件') };
  }

  // 4) 已存在：内容相同 → 幂等；内容不同 → 拒，绝不覆盖用户已有的文件。
  let existed = false;
  try {
    const st = fs.lstatSync(target);
    if (!st.isFile()) {
      return { ok: false, reason: reason(`「${rel}」已存在但不是普通文件`, '先人工处理该路径，再重试') };
    }
    existed = true;
    const current = fs.readFileSync(target, 'utf8');
    if (current === content) return { ok: true, written: false };
    return {
      ok: false,
      reason: reason(`「${rel}」已存在且内容不同，不覆盖`, '先人工确认差异；要改就自己改这个文件，脚手架不代写'),
    };
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, reason: reason(`读取「${rel}」失败（${(err && err.message) || ''}）`, '确认文件权限后重试') };
    }
  }

  // 5) 原子写：先写 .tmp 再 rename，避免留下半写文件。
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误。
    }
    return { ok: false, reason: reason(`写入「${rel}」失败（${(err && err.message) || ''}）`, '确认项目目录可写后重试') };
  }
  return { ok: true, written: !existed };
}
