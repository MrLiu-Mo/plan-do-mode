#!/usr/bin/env node
/**
 * 发布准备度检查（零依赖，只用 node: 内置模块）。
 *
 * 为什么需要它：`node --test` 只管代码对不对，`verify-pack` 只管清单全不全。
 * 「能不能发出去」是第三件事，而且包含一堆**只有发布那一刻才在意**的东西：
 * 元数据填了没、版本号对不对、文档里的 tgz 链接是不是还挂着 `<owner>` 占位、
 * 工作区是不是干净的。把这些塞进 `node --test` 会让开发期天天红，
 * 所以单独一条命令，发布前手动跑。
 *
 * 它**不**改任何文件、不联网、不发布——只报告还差什么。
 *
 * 用法：node scripts/release-check.mjs
 * 全 ✓ 时打印一行摘要并 exit 0；有阻塞项时逐条列出并 exit 1。
 * 「建议项」（不是阻塞）单独标出，不影响退出码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 占位符：**必须出现在网址里**才算没改完。
 *
 * 早先这里只匹配 `<owner>` / `example.com` 这几个字面量，于是任何一句
 * 「文档里还有 `<owner>` 吗」的**说明性文字**都会被判成阻塞项——
 * `docs/RELEASE.md` 100% 误报（第一版就是这么红的），`docs/INSTALL.md`
 * 解释同一个检查时也一样。而检查真正在意的是「还有没有指向假仓库的**网址**」，
 * 所以要求占位符紧挨着 URL 的上下文（`https://`、`github.com/`、`@`、`git+`）。
 */
const PLACEHOLDER = /(?:https?:\/\/|git\+|github\.com\/|@)[^\s)]*?(?:<owner>|<your[-_ ]?name>|example\.com)/i;

/** 必须填真值的 package.json 字段（照 PLAN §10.2 的包元数据清单）。 */
const REQUIRED_META = ['name', 'version', 'description', 'license', 'repository', 'homepage', 'bugs', 'icon'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * 纯函数：给定元数据与文档文本，算出「发布准备度」。
 * 测试直接调这个函数，不碰真实仓库状态。
 *
 * @param {object} meta package.json 解析后的对象
 * @param {{readme: string, plan: string, install: string}} docs 三份含 tgz 链接的文档
 * @param {{gitStatus: string, testsExpected?: number}} env 环境快照
 * @returns {{blockers: string[], suggestions: string[]}}
 */
export function checkRelease(meta, docs, env = {}) {
  const blockers = [];
  const suggestions = [];

  // ── 1. 元数据 ────────────────────────────────────────────────────
  for (const key of REQUIRED_META) {
    const value = meta[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      blockers.push(`package.json 缺 ${key}（PLAN §10.2 要求发布前填全）`);
    }
  }
  if (meta.repository && typeof meta.repository === 'object' && !meta.repository.url) {
    blockers.push('package.json 的 repository 是对象但缺 url');
  }
  for (const key of ['repository', 'homepage', 'bugs', 'icon']) {
    const text = typeof meta[key] === 'object' && meta[key] ? JSON.stringify(meta[key]) : String(meta[key] ?? '');
    if (text && PLACEHOLDER.test(text)) blockers.push(`package.json 的 ${key} 还含着占位符：${text}`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(meta.version || ''))) {
    blockers.push(`package.json 的 version 不是合法 semver：${meta.version}`);
  }
  if (!Array.isArray(meta.keywords) || !meta.keywords.includes('dsh-plugin')) {
    blockers.push('package.json 的 keywords 缺 dsh-plugin（市场索引靠它发现）');
  }
  if (meta.dsh?.bundle?.patch !== './cordis.patch.yml') {
    blockers.push('package.json 的 dsh.bundle.patch 不是 ./cordis.patch.yml');
  }

  // ── 2. 文档里的占位符与版本号 ─────────────────────────────────────
  //
  // `docs/RELEASE.md` **不参与**占位符扫描：它本身就是「怎么换掉占位符」的说明书，
  // 正文里必然要写出 `<owner>` 长什么样。扫它只会 100% 误报（第一版就是这么红的）。
  const tgzName = `${String(meta.name || '').replace(/^@[^/]+\//, '')}-${meta.version}.tgz`;
  for (const [name, text] of Object.entries(docs || {})) {
    if (typeof text !== 'string') continue;
    const isMeta = name.endsWith('RELEASE.md');
    if (!isMeta && PLACEHOLDER.test(text)) {
      const lines = text.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => PLACEHOLDER.test(line))
        .slice(0, 3)
        .map(([n, line]) => `第 ${n} 行：${line.trim().slice(0, 80)}`);
      blockers.push(`${name} 还含着占位符（发布前必须换成真实仓库）→ ${lines.join(' / ')}`);
    }
    // README / INSTALL 里出现的 .tgz 文件名必须与当前版本号一致
    const tgzRefs = [...text.matchAll(/([\w.-]+-(\d+\.\d+\.\d+)\.tgz)/g)].map((m) => m[1]);
    for (const ref of new Set(tgzRefs)) {
      if (ref !== tgzName) suggestions.push(`${name} 里的 tgz 文件名 ${ref} 与当前版本不一致（应为 ${tgzName}）`);
    }
  }

  // ── 3. 工作区状态 ────────────────────────────────────────────────
  if (typeof env.gitStatus === 'string' && env.gitStatus.trim() !== '') {
    const lines = env.gitStatus.trim().split('\n');
    blockers.push(`工作区有 ${lines.length} 个未提交改动（发布要能对得上 git log）：${lines.slice(0, 3).map((l) => l.trim()).join(' / ')}`);
  }
  if (Number.isInteger(env.testsExpected) && env.testsExpected <= 0) {
    blockers.push('测试条数异常');
  }
  // 发布前必须已打 tag 的提醒（不是阻塞：tag 可以在 publish 后补）
  if (env.gitStatus === '' && env.headTag === '') {
    suggestions.push('当前 HEAD 没有 tag——发布建议打 v<version> 标签，Release 页要用它');
  }

  return { blockers, suggestions };
}

/** 跑一条 git 命令，返回 stdout（失败返回空串，不抛）。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function main() {
  const meta = JSON.parse(read('package.json'));
  const docs = {
    'README.md': read('README.md'),
    'README.zh.md': read('README.zh.md'),
    'PLAN.md': read('PLAN.md'),
    'docs/INSTALL.md': read('docs/INSTALL.md'),
    'docs/RELEASE.md': read('docs/RELEASE.md'),
  };
  const { blockers, suggestions } = checkRelease(meta, docs, {
    gitStatus: git(['status', '--porcelain']),
    headTag: git(['tag', '--points-at', 'HEAD']),
  });

  if (blockers.length === 0) {
    console.log(`release ok: ${meta.name}@${meta.version} 元数据齐、文档无占位、工作区干净`);
  } else {
    console.error(`release check failed: ${blockers.length} blocker(s)`);
    for (const blocker of blockers) console.error(`  ✗ ${blocker}`);
  }
  for (const suggestion of suggestions) console.error(`  · 建议：${suggestion}`);
  if (blockers.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
