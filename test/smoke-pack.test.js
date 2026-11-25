// test/smoke-pack.test.js —— 分发包「解开之后能用」的判定逻辑。
//
// smoke-pack.mjs 要真跑 npm pack + tar 才有意义（那一步在 CI 与本地手动跑），
// 这里只测它的纯函数 checkExtracted：包里该有什么、不该有什么。
// 与 verify-pack.test.js 的分工：那边测 npm pack 的**清单**，这边测解包出来的**目录**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = await import(pathToFileURL(path.join(ROOT, 'scripts', 'smoke-pack.mjs')).href);
const { checkExtracted } = smoke;

/** 造一个「合格的解包目录」。 */
function goodRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-smoke-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of ['cordis.patch.yml', 'README.md', 'LICENSE', 'locale/zh.json', 'lib/index.js', 'docs/CONTRACT.md']) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x', 'utf8');
  }
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'dsh-plan-do', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'utf8',
  );
  return root;
}

test('smoke-pack：合格的解包目录通过', (t) => {
  const result = checkExtracted(goodRoot(t));
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('smoke-pack：缺 lib/index.js 失败（清单齐了但模块没进包）', (t) => {
  const root = goodRoot(t);
  fs.rmSync(path.join(root, 'lib', 'index.js'));
  const result = checkExtracted(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('lib/index.js')), result.problems.join('\n'));
});

test('smoke-pack：混进 test/ 或内部审查报告失败', (t) => {
  const root = goodRoot(t);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'REVIEW-tools.md'), 'x', 'utf8');
  const result = checkExtracted(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('test')), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p.includes('REVIEW-tools.md')), result.problems.join('\n'));
});

test('smoke-pack：包内 package.json 的 type / patch / name 错了都失败', (t) => {
  const root = goodRoot(t);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'renamed', type: 'commonjs', dsh: { bundle: { patch: './nope.yml' } } }),
    'utf8',
  );
  const result = checkExtracted(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('type')), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p.includes('dsh.bundle.patch')), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p.includes('包名')), result.problems.join('\n'));
});

test('smoke-pack：package.json 坏掉时不抛，返回可读问题', (t) => {
  const root = goodRoot(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{ not json', 'utf8');
  const result = checkExtracted(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('读不出来')), result.problems.join('\n'));
});
