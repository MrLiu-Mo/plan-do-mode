// test/scaffold.test.js —— lib/scaffold.js：白名单逐项放行 + 拒绝矩阵（不代写守卫）。
// 全部在 fs.mkdtempSync(os.tmpdir()) 出来的临时目录里跑，测完删掉；绝不碰真实项目。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeScaffold, WHITELIST } from '../lib/scaffold.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-scaffold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AI = { id: 't1', title: '初始化配置', owner: 'ai', minutes: 10 };
const USER = { id: 't2', title: '自己写业务代码', owner: 'user', minutes: 30 };
const FOLLOW = { id: 't3', title: '跟着做', owner: 'follow', minutes: 20 };

// 白名单逐项放行：11 项各一条断言（用子测试名标出文件名）。
test('白名单 11 项逐项放行，且真的写进项目根目录', (t) => {
  const dir = tmpDir(t);
  assert.equal(WHITELIST.length, 11, '白名单必须是 11 项，不许自行扩大或缩小');
  const names = [
    'package.json', '.gitignore', 'README.md', 'tsconfig.json', 'pyproject.toml',
    'requirements.txt', 'Cargo.toml', '.env.example', 'index.html', 'vite.config.js', 'vite.config.ts',
  ];
  assert.deepEqual([...WHITELIST], names);
  for (const name of names) {
    const r = writeScaffold(dir, name, `// ${name}\n`, AI);
    assert.equal(r.ok, true, `${name} 应放行：${r.reason}`);
    assert.equal(r.written, true, `${name} 首次写应 written:true`);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), `// ${name}\n`);
    assert.equal(fs.existsSync(path.join(dir, `${name}.tmp`)), false, '不能留下 .tmp');
  }
});

test('拒绝：不在白名单（src/app.js、lib/index.js、cordis.patch.yml）', (t) => {
  const dir = tmpDir(t);
  for (const bad of ['src/app.js', 'lib/index.js', 'cordis.patch.yml', 'main.py', 'random.txt']) {
    const r = writeScaffold(dir, bad, 'x', AI);
    assert.equal(r.ok, false, `${bad} 必须被拒`);
    assert.match(r.reason, /不在白名单/);
    assert.match(r.reason, /^plando：/);
    assert.match(r.reason, /——下一步：/);
  }
  assert.deepEqual(fs.readdirSync(dir), [], '被拒时目录里不该出现任何文件（连子目录都不该建）');
});

test('拒绝：路径穿越（../evil.txt、子目录形式、绝对路径、Windows 盘符路径）', (t) => {
  const dir = tmpDir(t);
  const cases = [
    '../evil.txt',
    '../../evil.txt',
    'sub/package.json',
    'foo/../package.json',
    path.join(dir, 'package.json'),
    'A:\\evil\\package.json',
    '/etc/passwd',
  ];
  for (const bad of cases) {
    const r = writeScaffold(dir, bad, 'x', AI);
    assert.equal(r.ok, false, `${bad} 必须被拒`);
  }
  // `..` 与绝对路径各自有明确理由
  assert.match(writeScaffold(dir, '../evil.txt', 'x', AI).reason, /\.\.|不在白名单/);
  assert.match(writeScaffold(dir, path.join(dir, 'package.json'), 'x', AI).reason, /绝对路径/);
  assert.match(writeScaffold(dir, 'sub/package.json', 'x', AI).reason, /不在白名单/);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.txt')), false, '绝不能写到项目目录外面');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('拒绝：TECH 项归属不是 ai（user / follow / 缺失 / 非对象）', (t) => {
  const dir = tmpDir(t);
  for (const item of [USER, FOLLOW, {}, null, undefined, 'ai']) {
    const r = writeScaffold(dir, 'package.json', '{}', item);
    assert.equal(r.ok, false, `${JSON.stringify(item)} 必须被拒`);
    assert.match(r.reason, /归属不是 ai/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
});

test('拒绝：已存在且内容不同，绝不覆盖', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"user-version"}\n', 'utf8');
  const r = writeScaffold(dir, 'package.json', '{"name":"ai-version"}\n', AI);
  assert.equal(r.ok, false);
  assert.match(r.reason, /已存在且内容不同/);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{"name":"user-version"}\n', '用户文件必须原样保留');
});

test('幂等：已存在且内容完全相同 → ok:true 且 written:false', (t) => {
  const dir = tmpDir(t);
  assert.equal(writeScaffold(dir, '.gitignore', 'node_modules/\n', AI).written, true);
  const again = writeScaffold(dir, '.gitignore', 'node_modules/\n', AI);
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.written, false);
});

test('拒绝：目标是符号链接 / 目录联结（逃逸验证；建不了链接则跳过）', (t) => {
  const dir = tmpDir(t);
  const outside = tmpDir(t);
  const link = path.join(dir, 'package.json');
  let made = '';
  try {
    // 先试普通文件符号链接（Windows 非管理员常被拒）。
    fs.symlinkSync(path.join(outside, 'target.json'), link, 'file');
    made = 'file';
  } catch {
    try {
      // 退一步用目录联结：对 scaffold 而言同样是指向项目外的链接。
      fs.symlinkSync(outside, link, 'junction');
      made = 'junction';
    } catch {
      t.skip('当前环境无权限创建符号链接');
      return;
    }
  }
  const r = writeScaffold(dir, 'package.json', '{}', AI);
  assert.equal(r.ok, false, '链接不能被写穿');
  assert.match(r.reason, made === 'file' ? /符号链接/ : /符号链接|不是普通文件/);
  assert.equal(fs.existsSync(path.join(outside, 'target.json')), false, '绝不能透过链接写到目录外');
});

test('拒绝：参数形状不对（空 dir / 空路径 / content 不是字符串）', (t) => {
  const dir = tmpDir(t);
  assert.equal(writeScaffold('', 'package.json', '{}', AI).ok, false);
  assert.equal(writeScaffold(dir, '', '{}', AI).ok, false);
  assert.equal(writeScaffold(dir, '   ', '{}', AI).ok, false);
  assert.equal(writeScaffold(dir, 'package.json', null, AI).ok, false);
  assert.equal(writeScaffold(dir, 'package.json', {}, AI).ok, false);
});

test('项目目录不存在时自动建（不改别的路径）', (t) => {
  const root = tmpDir(t);
  const dir = path.join(root, 'nested', 'proj');
  const r = writeScaffold(dir, 'README.md', '# hi\n', AI);
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# hi\n');
  assert.deepEqual(fs.readdirSync(dir), ['README.md']);
});
