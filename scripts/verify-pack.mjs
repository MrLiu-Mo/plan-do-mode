#!/usr/bin/env node
/**
 * 分发包清单验证（零依赖，只用 node: 内置模块）。
 *
 * 为什么需要它：`files` 白名单漏一项（比如 locale/zh.json），本地 link 安装一切正常，
 * 别人装完却是空标题。这是「零依赖」保护不了的分发特有失败模式（PLAN §10.3 / 验收 A8）。
 *
 * 做法：真跑 `npm pack --dry-run --json`，拿它输出的清单逐条断言。
 * 断言核心抽成纯函数 checkPackList(fileList, expected)，测试直接调，不必真跑 npm。
 *
 * 用法：node scripts/verify-pack.mjs
 * 通过打印一行摘要 exit 0；失败逐条打印问题 exit 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 从仓库现状收集「包里必须有的东西」。
 * lib/ 与 docs/ 是现读目录，不是写死的清单——新增模块忘了进白名单时能抓到。
 */
export function collectExpected(root = ROOT) {
  const list = (rel) => {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  };
  const libFiles = list('lib').filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`);
  const docFiles = list('docs').filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`);

  return {
    // 单独一组，少任何一个都要报「新增模块漏进 files 白名单」
    libFiles,
    requiredFiles: [
      'package.json',
      'cordis.patch.yml',
      'locale/en.json',
      'locale/zh.json',
      'icon.svg',
      'README.md',
      'LICENSE',
      ...docFiles,
    ],
    // 这些前缀 / 文件名不允许出现在包里
    forbiddenPrefixes: ['test/', 'scripts/', '.git', '.github/', 'node_modules/'],
    forbiddenFiles: ['package-lock.json', 'pnpm-lock.yaml'],
  };
}

/**
 * 纯函数：拿一份文件清单，判断它是不是一个合格的分发包。
 * @param {string[]} fileList npm pack 报出来的相对路径列表
 * @param {ReturnType<typeof collectExpected>} expected
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkPackList(fileList, expected) {
  const problems = [];
  const has = new Set(Array.isArray(fileList) ? fileList : []);

  for (const file of expected.libFiles || []) {
    if (!has.has(file)) problems.push(`缺少模块：${file}（新增 lib 文件后要确认 files 白名单含 lib）`);
  }
  for (const file of expected.requiredFiles || []) {
    if (!has.has(file)) problems.push(`缺少文件：${file}`);
  }
  for (const prefix of expected.forbiddenPrefixes || []) {
    for (const file of has) {
      if (file === prefix || file.startsWith(prefix)) problems.push(`不该被打包：${file}（禁止前缀 ${prefix}）`);
    }
  }
  for (const file of expected.forbiddenFiles || []) {
    if (has.has(file)) problems.push(`不该被打包：${file}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 校验根 package.json 的分发元数据。
 * 这几项错了，装上去也不会被识别成 mode bundle。
 */
export function checkPackageMeta(meta) {
  const problems = [];
  if (meta.type !== 'module') problems.push(`package.json：type 应为 "module"，实际 ${JSON.stringify(meta.type)}`);
  if (meta.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push(`package.json：dsh.bundle.patch 应为 "./cordis.patch.yml"，实际 ${JSON.stringify(meta.dsh?.bundle?.patch)}`);
  }
  if (!Array.isArray(meta.files) || meta.files.length === 0) problems.push('package.json：files 白名单为空');
  if (!String(meta.description || '').trim()) problems.push('package.json：缺少 description');
  return { ok: problems.length === 0, problems };
}

/** 找 npm 的可执行入口：优先用当前 node 直接跑 npm-cli.js，避免 Windows 的 .cmd 执行问题。 */
function npmCandidates() {
  const nodeDir = path.dirname(process.execPath);
  return [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/** 跑一次 `npm pack --dry-run --json`，返回解析后的首个结果对象。 */
function runPack() {
  const args = ['pack', '--dry-run', '--json'];
  const attempts = [];

  for (const cli of npmCandidates()) {
    if (!fs.existsSync(cli)) continue;
    attempts.push(() => execFileSync(process.execPath, [cli, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  attempts.push(() => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  attempts.push(() => execSync(`npm ${args.join(' ')}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

  const errors = [];
  for (const attempt of attempts) {
    try {
      const stdout = String(attempt() || '');
      // npm 有时会在 stdout 前混进提示行，从第一个 [ 开始截。
      const start = stdout.indexOf('[');
      if (start < 0) throw new Error('输出里没有 JSON 数组');
      const parsed = JSON.parse(stdout.slice(start));
      if (!Array.isArray(parsed) || !parsed[0]?.files) throw new Error('JSON 里没有 files 清单');
      return parsed[0];
    } catch (error) {
      errors.push(String(error.message || error).split('\n')[0]);
    }
  }
  throw new Error(`npm pack 跑不起来：${errors.join(' | ')}`);
}

function main() {
  let pack;
  try {
    pack = runPack();
  } catch (error) {
    console.error(`verify-pack failed: ${error.message}`);
    process.exit(1);
  }

  const fileList = pack.files.map((entry) => entry.path);
  const expected = collectExpected(ROOT);
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const listResult = checkPackList(fileList, expected);
  const metaResult = checkPackageMeta(meta);
  const problems = [...listResult.problems, ...metaResult.problems];

  if (problems.length > 0) {
    console.error(`verify-pack failed: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const sizeKb = Math.round(pack.size / 1024);
  console.log(
    `pack ok: ${fileList.length} files, ${expected.libFiles.length} modules, `
    + `${expected.requiredFiles.length} required, ${sizeKb} kB (${pack.filename})`,
  );
}

// 只在直接执行时跑 main；被 import 时不跑（测试只调纯函数）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
