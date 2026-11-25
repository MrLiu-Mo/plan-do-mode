// test/git.test.js —— lib/git.js：真 git init 临时仓库，验证「只提交模式产物」。
//
// 关键断言（PLAN §7）：模式产物进 commit、用户自己写的文件不进 commit、
// 非 git 仓库跳过且不抛错、无可提交内容时 skipped。
// 全部在 fs.mkdtempSync(os.tmpdir()) 里跑；每次都配 user.name / user.email，
// 否则 commit 在干净环境里会直接失败（这是本项目踩过的坑）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { commitArtifacts, recentCommits, ARTIFACT_PATHS } from '../lib/git.js';

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// 真建一个仓库，并配好身份与默认分支（避免默认分支名告警干扰断言）。
function makeRepo(t, name = 'repo') {
  const dir = path.join(tmpRoot(t), name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'plando test');
  git('config', 'user.email', 'plando-test@example.com');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git };
}

// 写文件（自动建父目录）并可选加入暂存区。
function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// 某次提交实际包含的文件列表。
function filesInHead(dir) {
  const out = execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// 工作区 / 暂存区是否干净。
function isClean(dir) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  return out.trim() === '';
}

test('ARTIFACT_PATHS 白名单固定为契约里的 5 项，且不含 -A / 任意路径', () => {
  assert.deepEqual([...ARTIFACT_PATHS], ['IDEA.md', 'TECH.md', 'HANDOFF.md', 'CHANGE-GUIDE.md', '.plando']);
  assert.equal(ARTIFACT_PATHS.includes('-A'), false);
  assert.equal(ARTIFACT_PATHS.includes('.'), false);
});

test('提交只含模式产物；用户自己写的文件不进 commit', (t) => {
  const { dir } = makeRepo(t);
  write(dir, 'IDEA.md', '# 我的项目\n');
  write(dir, 'TECH.md', '# 技术拆解\n');
  write(dir, '.plando/state.json', '{ "schemaVersion": 1 }\n');
  // 用户自己的代码与文档：必须原封不动留在工作区，不进暂存区。
  write(dir, 'src/app.js', 'export const a = 1;\n');
  write(dir, 'notes.md', '随手记\n');

  const result = commitArtifacts(dir, 'plando(clarify): clarify_done');
  assert.equal(result.committed, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.files.sort(), ['.plando/state.json', 'IDEA.md', 'TECH.md'].sort());

  const inCommit = filesInHead(dir);
  assert.ok(inCommit.includes('IDEA.md'));
  assert.ok(inCommit.includes('TECH.md'));
  assert.ok(inCommit.includes('.plando/state.json'));
  // 用户文件绝不在这个 commit 里。
  assert.equal(inCommit.includes('src/app.js'), false);
  assert.equal(inCommit.includes('notes.md'), false);

  // 用户文件仍在工作区，未被提交、未被删除。
  assert.ok(fs.existsSync(path.join(dir, 'src/app.js')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.md')));
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.match(status, /src\/app\.js/);
  assert.match(status, /notes\.md/);

  // 提交主题原文保留，正文带 plan-do-mode 标识（PLAN §7）。
  const body = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: dir, encoding: 'utf8' });
  assert.match(body, /plando\(clarify\): clarify_done/);
  assert.match(body, /plan-do-mode/);
});

test('用户已自己 git add 的文件：不被带进模式产物的 commit', (t) => {
  const { dir, git } = makeRepo(t);
  // 先有一个基线提交，否则看起来像第一次提交。
  write(dir, 'keep.txt', 'base\n');
  git('add', 'keep.txt');
  git('commit', '-m', 'init');

  write(dir, 'IDEA.md', '# 模式产物\n');
  write(dir, 'user.js', 'export const user = 1;\n');
  git('add', 'user.js'); // 用户主动暂存了自己的文件

  const result = commitArtifacts(dir, 'plando(clarify): 只提交产物');
  assert.equal(result.committed, true);
  const inCommit = filesInHead(dir);
  assert.ok(inCommit.includes('IDEA.md'));
  assert.equal(inCommit.includes('user.js'), false);
  // 用户的暂存状态原封不动保留着（仍然 staged，等他自己提交）。
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
  assert.match(staged, /user\.js/);
});

test('无可提交内容时 skipped，不产生空 commit', (t) => {
  const { dir } = makeRepo(t);
  write(dir, 'IDEA.md', '# 一样的内容\n');
  const first = commitArtifacts(dir, 'plando(idea): idea_ok');
  assert.equal(first.committed, true);
  const countAfterFirst = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());

  // 内容没变，再提交一次：应当 skipped。
  const second = commitArtifacts(dir, 'plando(idea): idea_ok');
  assert.equal(second.committed, false);
  assert.equal(second.skipped, true);
  assert.match(second.reason, /^plando：/);
  assert.deepEqual(second.files, []);
  // commit 数没变。
  assert.equal(Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()), countAfterFirst);
});

test('目录里没有任何模式产物时 skipped，也不碰用户文件', (t) => {
  const { dir } = makeRepo(t);
  write(dir, 'src/app.js', 'export const a = 1;\n');
  const result = commitArtifacts(dir, 'plando: 什么都没有');
  assert.equal(result.committed, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /没有可提交的模式产物/);
  // 用户文件仍未被提交。
  assert.equal(isClean(dir), false);
  // 仓库里一个被跟踪的文件都没有：用户文件完全没被加进索引。
  assert.deepEqual(execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim(), '');
});

test('非 git 仓库：skipped 且不抛错', (t) => {
  const dir = path.join(tmpRoot(t), 'plain');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'IDEA.md', '# 没仓库\n');

  let result;
  assert.doesNotThrow(() => {
    result = commitArtifacts(dir, 'plando: 无仓库');
  });
  assert.equal(result.committed, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /不是 git 仓库/);
  assert.deepEqual(result.files, []);
});

test('目录不存在 / 空参数：skipped 且不抛错', (t) => {
  const ghost = path.join(tmpRoot(t), 'ghost');
  const r1 = commitArtifacts(ghost, 'x');
  assert.equal(r1.skipped, true);
  assert.equal(r1.committed, false);

  const r2 = commitArtifacts('', 'x');
  assert.equal(r2.skipped, true);
  assert.equal(r2.committed, false);
});

test('被 .gitignore 忽略的模式产物不强制提交', (t) => {
  const { dir } = makeRepo(t);
  write(dir, '.gitignore', '.plando/\n');
  write(dir, '.plando/state.json', '{}\n');
  write(dir, 'IDEA.md', '# 只有 IDEA\n');

  const result = commitArtifacts(dir, 'plando(clarify): 忽略 .plando');
  assert.equal(result.committed, true);
  // .plando 被忽略 → 只提交 IDEA.md，且绝不 -f。
  assert.deepEqual(result.files, ['IDEA.md']);
  assert.equal(filesInHead(dir).includes('.plando/state.json'), false);
});

test('recentCommits 能读回最近提交', (t) => {
  const { dir } = makeRepo(t);
  write(dir, 'IDEA.md', '# v1\n');
  commitArtifacts(dir, 'plando(clarify): 第一条');
  write(dir, 'IDEA.md', '# v2\n');
  commitArtifacts(dir, 'plando(idea): 第二条');

  const lines = recentCommits(dir, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /第二条/);
  assert.match(lines[1], /第一条/);
  // 非 git 仓库返回空数组而不是抛错。
  assert.deepEqual(recentCommits(path.join(tmpRoot(t), 'none')), []);
});
