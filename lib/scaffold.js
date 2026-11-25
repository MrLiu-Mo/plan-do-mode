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
 */
const SAFE_SCRIPT_KEYS = Object.freeze([
  'test', 'tests', 'lint', 'build', 'dev', 'start', 'typecheck', 'check', 'format', 'test:unit', 'test:e2e',
]);

/**
 * `scripts` 的**值**也要看：键名合法不代表内容合法（REVIEW-tools G2 的核心）。
 * 这些钩子的价值在于「用户下次 npm test / npm install 时会执行它」——
 * 一条 `node -e "…rmSync('src')…"` 就是「AI 在你机器上预埋了一条命令」。
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
 * 依赖的值也可能执行代码：`file:` / `link:` / `http(s):` / `git+…` 指向的包，
 * 装的时候会跑它自己的 `postinstall`（REVIEW-tools G2 的 `dependencies` 那条）。
 * 只允许普通的「名字 + 版本区间」。
 */
const DEP_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const SAFE_VERSION_RE = /^(?:[\^~<>=\s]*\d|latest$|\*$|workspace:)/i;

/** 内容校验：文件名对了不等于内容对（REVIEW-tools G2）。返回 null 表示放行，否则返回人话理由。 */
export function validateContent(rel, content) {
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
        if (!SAFE_SCRIPT_KEYS.includes(key)) {
          return `「${name}」里的 scripts.${key} 不在允许的脚本键里（${SAFE_SCRIPT_KEYS.join(' / ')}）——生命周期钩子（postinstall 之类）会替你执行命令`;
        }
        const value = scripts[key];
        if (typeof value !== 'string') return `「${name}」里的 scripts.${key} 必须是字符串`;
        // 值才是真正会被执行的东西（REVIEW-tools G2）。
        if (SCRIPT_VALUE_DENY.some((re) => re.test(value))) {
          return `「${name}」里的 scripts.${key} 内容是「${value}」——这条命令会在你自己跑测试时执行，脚手架不代写`;
        }
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
 * writeScaffold(dir, relativePath, content, techItem) -> { ok, written?, reason? }
 * 只允许写白名单里的顶层配置文件，且 techItem.owner === 'ai'。
 */
export function writeScaffold(dir, relativePath, content, techItem) {
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
  const contentBad = validateContent(rel, content);
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
