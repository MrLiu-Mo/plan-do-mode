// lib/git.js —— 自动提交：只提交「模式产物」，绝不碰用户正在写的代码。
//
// 硬约束（PLAN §7）：
//   1. 只 `git add -- IDEA.md TECH.md HANDOFF.md CHANGE-GUIDE.md .plando`，**绝不 git add -A**。
//   2. 不是 git 仓库 → 返回 { committed:false, skipped:true, reason }，不抛错。
//   3. 没有可提交内容 → skipped:true。
//   4. 一律 execFileSync('git', [args], { cwd })，不经 shell 拼接。
// 零依赖：只 import node: 内置模块（docs/API-FACTS.md §4）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 允许进入提交的路径白名单（PLAN §3 产物表 + .plando 机器状态）。
// VERIFY.md 原来漏了：verify 阶段渲染出它但 autoCommit 不带，实测会留成 `?? VERIFY.md`（REVIEW-tools L6）。
export const ARTIFACT_PATHS = Object.freeze(['IDEA.md', 'TECH.md', 'VERIFY.md', 'HANDOFF.md', 'CHANGE-GUIDE.md', '.plando']);

// 提交正文里的标识，便于识别与回滚（PLAN §7）。
const MARKER = 'plan-do-mode';

/**
 * 跑一条 git 命令，永不抛错：把退出码与输出收在返回值里。
 * @returns {{ok: boolean, code: number, stdout: string, stderr: string}}
 */
function runGit(cwd, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (err) {
    const code = typeof err.status === 'number' ? err.status : 1;
    return {
      ok: false,
      code,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    };
  }
}

// 在 dir 里查一个路径是否被 .gitignore 忽略（忽略则绝不 -f 强加）。
function isIgnored(cwd, target) {
  const res = runGit(cwd, ['check-ignore', '-q', '--', target]);
  return res.code === 0;
}

// 已暂存的「模式产物」文件列表（空数组 = 没东西可提交）。
// 用 pathspec 限定，避免把用户自己 git add 的文件算进来。
function stagedFiles(cwd, targets) {
  const res = runGit(cwd, ['diff', '--cached', '--name-only', '--', ...targets]);
  if (!res.ok) return [];
  return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * 提交模式产物。
 * @param {string} dir 项目目录（git 仓库工作区内）
 * @param {string} [message] 提交主题；会自动补上 plan-do-mode 标识
 * @returns {{committed: boolean, skipped: boolean, reason?: string, files: string[]}}
 */
export function commitArtifacts(dir, message) {
  const skipped = (reason, files = []) => ({ committed: false, skipped: true, reason, files });
  const failed = (reason, files = []) => ({ committed: false, skipped: false, reason, files });

  if (typeof dir !== 'string' || dir.trim() === '') {
    return skipped('plando：没给项目目录，跳过自动提交——先确定项目路径。');
  }
  const cwd = path.resolve(dir.trim());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return skipped(`plando：项目目录 ${cwd} 不存在，跳过自动提交——先确认路径或重新立项。`);
  }

  // 1) 是不是 git 仓库？不是就跳过，不报错（PLAN §7）。
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return skipped(`plando：${cwd} 不是 git 仓库，跳过自动提交——需要版本留痕就先在项目里 git init。`);
  }

  // 2) 只挑白名单里「存在且未被忽略」的路径；绝不 -f 强加用户忽略的东西。
  const targets = [];
  const ignored = [];
  for (const rel of ARTIFACT_PATHS) {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) continue;
    if (isIgnored(cwd, rel)) {
      ignored.push(rel);
      continue;
    }
    targets.push(rel);
  }
  if (targets.length === 0) {
    const tail = ignored.length > 0 ? `（${ignored.join('、')} 被 .gitignore 忽略，不强制提交）` : '';
    return skipped(`plando：没有可提交的模式产物，跳过自动提交${tail}——先推进阶段让产物落盘。`);
  }

  // 3) 只 add 白名单路径，绝不 git add -A。
  const added = runGit(cwd, ['add', '--', ...targets]);
  if (!added.ok) {
    return failed(`plando：git add 模式产物失败（${added.stderr.trim() || '未知原因'}）——检查仓库状态后重试。`);
  }

  // 4) 暂存区里属于模式产物的条目为空 = 没有可提交内容。
  const files = stagedFiles(cwd, targets);
  if (files.length === 0) {
    const tail = ignored.length > 0 ? `（${ignored.join('、')} 被忽略）` : '';
    return skipped(`plando：模式产物与上次提交没有差异，跳过自动提交${tail}。`);
  }

  // 5) 提交时再用 pathspec 收窄一次：用户自己 `git add` 过的文件即使已在暂存区，
  //    也绝不会被带进这次 commit（PLAN §7「不碰用户正在写的代码」）。
  const subject = normalizeSubject(message);
  const committed = runGit(cwd, [
    'commit',
    '--no-verify',
    '-m',
    subject,
    '-m',
    `${MARKER}: 只含模式产物（${files.length} 个文件）`,
    '--',
    ...targets,
  ]);
  if (!committed.ok) {
    return failed(`plando：git commit 失败（${committed.stderr.trim() || '未知原因'}）——检查 hooks / 签名 / user.name 配置。`, files);
  }
  return { committed: true, skipped: false, files };
}

// 提交主题：去掉换行、截断，保证单行；空则给默认值。
function normalizeSubject(message) {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (raw === '') return `plando: 更新模式产物`;
  const singleLine = raw.split(/\r?\n/)[0].trim().slice(0, 100);
  return singleLine === '' ? `plando: 更新模式产物` : singleLine;
}

/** 读最近 n 条提交的主题（测试用，也方便 tools 展示）。 */
export function recentCommits(dir, n = 5) {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const res = runGit(path.resolve(dir), ['log', `-n${Math.max(1, Math.trunc(n) || 5)}`, '--pretty=%h %s']);
  if (!res.ok) return [];
  return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export default commitArtifacts;
