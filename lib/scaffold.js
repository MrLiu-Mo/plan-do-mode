// lib/scaffold.js
// 配置/脚手架白名单写入：plando_scaffold 的唯一落点（PLAN §五「不代写」的例外）。
// 契约来源：PLAN §五（守卫与「不代写」的落点）、docs/CONTRACT.md §5（错误消息形状）。
// 硬约束：
//   - 零依赖：只 import node: 内置模块。
//   - 白名单只有下面 WHITELIST 里那 11 个顶层文件名，不自作主张扩大。
//   - 还必须对应 TECH 清单里归属为 ai 的条目（techItem.owner === 'ai'）。
//   - 路径必须 resolve 后仍在项目目录内；绝对路径、`..`、符号链接逃逸一律拒。
//   - 已存在且内容完全相同 → 幂等返回 { ok:true, written:false }；内容不同 → 拒（不覆盖用户的文件）。

import fs from 'node:fs';
import path from 'node:path';

/** 白名单（逐字照抄 PLAN §五 的裁剪版，只保留 R4 允许的 11 项）。 */
export const WHITELIST = Object.freeze([
  'package.json',
  '.gitignore',
  'README.md',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  '.env.example',
  'index.html',
  'vite.config.js',
  'vite.config.ts',
]);

const ALLOWED = new Set(WHITELIST);

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`。
function reason(why, next) {
  const head = '现在是「边做边学」阶段，';
  const tail = `——下一步：${next}`;
  const budget = 160 - 6 /* plando： */ - [...head].length - [...tail].length;
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
