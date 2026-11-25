// test/project.test.js —— lib/project.js：立项 / 读写 / 原子写 / 损坏状态 / 旧版迁移 / 灵感库。
// 全部在 fs.mkdtempSync(os.tmpdir()) 出来的临时目录里跑，测完删掉；绝不碰 ~/.plando 或真实项目。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initProject, openProject, loadState, saveState,
  readIdeas, writeIdeas, listProjects, projectPaths,
} from '../lib/project.js';

// 每个测试独立的临时根目录；t.after 里删掉。
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-proj-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// 读回 state 并在失败时把 reason 抛出来，让断言看到真实原因。
function loadStateOne(dir) {
  const result = loadState(dir);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

// 在 dir 里手工铺一份 .plando/state.json（value 为字符串时按原文写，用来造损坏文件）。
function writeRawState(dir, value) {
  const paths = projectPaths(dir);
  fs.mkdirSync(paths.plandoDir, { recursive: true });
  fs.writeFileSync(paths.statePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return paths;
}

test('initProject 建 .plando/、写初始 state 和空日志', (t) => {
  const dir = path.join(tmpRoot(t), 'demo');
  const created = initProject(dir, { name: '小工具', budget: { mustUnderstand: 3, totalMinutes: 120 } });
  assert.equal(created.ok, true);
  assert.equal(created.dir, path.resolve(dir));
  assert.equal(created.state.stage, 'clarify');
  assert.equal(created.state.name, '小工具');
  // budget 是立项时写在 state 里的快照（CONTRACT §4）。
  assert.deepEqual(created.state.budget, { mustUnderstand: 3, totalMinutes: 120 });
  const paths = projectPaths(dir);
  assert.equal(paths.statePath, path.join(path.resolve(dir), '.plando', 'state.json'));
  assert.ok(fs.existsSync(paths.statePath));
  assert.ok(fs.existsSync(paths.logPath));
});

test('initProject 默认预算；已有 state 时 ok:false 不覆盖', (t) => {
  const root = tmpRoot(t);
  const fresh = initProject(path.join(root, 'a'), { name: '默认预算' });
  assert.deepEqual(fresh.state.budget, { mustUnderstand: 5, totalMinutes: 600 });

  const dir = path.join(root, 'p');
  initProject(dir, { name: '第一次' });
  saveState(dir, { ...loadStateOne(dir), stage: 'tech' });
  const again = initProject(dir, { name: '第二次' });
  assert.equal(again.ok, false);
  assert.match(again.reason, /^plando：/);
  assert.match(again.reason, /open/);
  assert.equal(loadStateOne(dir).name, '第一次');
});

test('saveState 读回一致，刷新 updatedAt，且不留 .tmp', (t) => {
  const dir = path.join(tmpRoot(t), 'p');
  const created = initProject(dir, { name: '改一下' });
  const next = saveState(dir, { ...created.state, stage: 'idea' });
  assert.equal(next.stage, 'idea');
  assert.ok(Date.parse(next.updatedAt) >= Date.parse(created.state.updatedAt));
  assert.equal(loadStateOne(dir).stage, 'idea');
  // 原子写：目录里只有预期文件，没有残留 .tmp。
  assert.deepEqual(fs.readdirSync(projectPaths(dir).plandoDir).sort(), ['log.jsonl', 'state.json']);
});

// REVIEW-tools §9.4 N14：读侧有 2 MB 上限，写侧没有对齐 → 一次调用就能把项目写成
// 「永久读不出来」（写入成功、之后每个工具都报超限，且没有 repair 通道）。
test('saveState：写入前挡住会把 state.json 顶过读上限的内容，并指出是哪个字段', (t) => {
  const dir = path.join(tmpRoot(t), 'cap');
  const created = initProject(dir, { name: '大字段' });
  const before = fs.statSync(projectPaths(dir).statePath).size;

  const huge = { ...created.state, note: 'x'.repeat(3 * 1024 * 1024) };
  assert.throws(() => saveState(dir, huge), /plando：.*写入上限/);
  // 报错要能定位：只说「太大」等于让人自己翻 JSON。
  assert.throws(() => saveState(dir, huge), /note/);
  // 拒写之后磁盘上还是原来那份可读的状态，没有半写。
  assert.equal(fs.statSync(projectPaths(dir).statePath).size, before);
  assert.equal(loadState(dir).ok, true, '拒写之后状态必须仍然读得出来');
});

test('saveState：刚好在限额内的正常增长照常写入', (t) => {
  const dir = path.join(tmpRoot(t), 'ok');
  const created = initProject(dir, { name: '正常' });
  // 512 KB 远小于 1.6 MB 的写上限，属正常量级。
  const next = saveState(dir, { ...created.state, note: 'y'.repeat(512 * 1024) });
  assert.equal(next.note.length, 512 * 1024);
  assert.equal(loadState(dir).ok, true);
});

test('loadState：state.json 不存在时返回 ok:false 而不是抛错', (t) => {
  const result = loadState(path.join(tmpRoot(t), 'nope'));
  assert.equal(result.ok, false);
  assert.equal(result.state, undefined);
  assert.match(result.reason, /^plando：/);
  assert.match(result.reason, /不存在/);
});

test('loadState：JSON 损坏 → ok:false，reason 带恢复建议且不覆盖坏文件', (t) => {
  const paths = writeRawState(path.join(tmpRoot(t), 'broken'), '{ "schemaVersion": 1, 坏掉了');
  const result = loadState(path.resolve(paths.plandoDir, '..'));
  assert.equal(result.ok, false);
  assert.equal(result.statePath, paths.statePath);
  assert.match(result.reason, /不是合法 JSON/);
  assert.match(result.reason, /不要删除重置/);
  assert.match(fs.readFileSync(paths.statePath, 'utf8'), /坏掉了/);
});

test('loadState：schemaVersion 非整数 / 高于当前 → ok:false 且写明版本', (t) => {
  const dir = path.join(tmpRoot(t), 'ver');
  writeRawState(dir, { schemaVersion: 'x' });
  const bad = loadState(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /schemaVersion/);

  writeRawState(dir, { schemaVersion: 99 });
  const high = loadState(dir);
  assert.equal(high.ok, false);
  assert.match(high.reason, /99/);
  assert.match(high.reason, /不要重置状态/);
});

test('loadState：已知旧版 0 → migrate 升到 1 并写回', (t) => {
  const dir = path.join(tmpRoot(t), 'old');
  const paths = writeRawState(dir, { schemaVersion: 0, name: '老项目', dir: path.resolve(dir), stage: 'tech' });
  const result = loadState(dir);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.state.schemaVersion, 1);
  // migrate 只补缺字段，不覆盖已有值（CONTRACT §4）。
  assert.equal(result.state.name, '老项目');
  assert.equal(result.state.stage, 'tech');
  assert.ok(Array.isArray(result.state.cards));
  // 写回后不再需要迁移。
  assert.equal(loadState(dir).migrated, undefined);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).schemaVersion, 1);
});

test('openProject 读回项目并带上绝对 dir 与 statePath', (t) => {
  const root = tmpRoot(t);
  const dir = path.join(root, 'open');
  const created = initProject(dir, { name: '打开我' });
  const opened = openProject(dir);
  assert.equal(opened.ok, true);
  assert.equal(opened.dir, path.resolve(dir));
  assert.equal(opened.statePath, projectPaths(dir).statePath);
  assert.equal(opened.state.name, '打开我');
  assert.equal(opened.state.projectId, created.state.projectId);
  assert.equal(opened.migrated, false);
  assert.equal(openProject(path.join(root, 'ghost')).ok, false);
});

test('灵感库：不存在返回 []，写入后读回；写入不留 .tmp', (t) => {
  const dataRoot = path.join(tmpRoot(t), 'data');
  assert.deepEqual(readIdeas(dataRoot), []);
  assert.equal(fs.existsSync(path.join(dataRoot, 'ideas.json')), false);
  const list = [{ id: 'i1', title: '记一条灵感', at: '2026-01-01T00:00:00.000Z' }];
  assert.deepEqual(writeIdeas(dataRoot, list), list);
  assert.deepEqual(readIdeas(dataRoot), list);
  assert.deepEqual(fs.readdirSync(dataRoot).filter((n) => n.endsWith('.tmp')), []);
});

test('灵感库：损坏时抛中文错误（不静默重置）；非数组也抛错', (t) => {
  const dataRoot = path.join(tmpRoot(t), 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'ideas.json'), 'not json', 'utf8');
  assert.throws(() => readIdeas(dataRoot), (err) => {
    assert.match(err.message, /^plando：/);
    assert.match(err.message, /灵感库/);
    return true;
  });
  fs.writeFileSync(path.join(dataRoot, 'ideas.json'), '{"ideas":[]}', 'utf8');
  assert.throws(() => readIdeas(dataRoot), /顶层不是数组/);
});

test('initProject 带 dataRoot：灵感库 + 索引；listProjects 可列出，坏索引项带 ok:false', (t) => {
  const root = tmpRoot(t);
  const dataRoot = path.join(root, 'data');
  initProject(path.join(root, 'a'), { name: '项目 A', dataRoot });
  initProject(path.join(root, 'b'), { name: '项目 B', dataRoot });
  assert.deepEqual(readIdeas(dataRoot), []);

  const rows = listProjects(dataRoot);
  assert.deepEqual(rows.map((row) => row.name).sort(), ['项目 A', '项目 B']);
  for (const row of rows) {
    assert.equal(row.ok, true);
    assert.equal(row.stage, 'clarify');
    assert.ok(row.projectId);
  }

  // 手工加一个「目录已不存在」的索引项：列出时带 ok:false，而不是整体抛错。
  const indexPath = path.join(dataRoot, 'projects.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.projects[path.resolve(path.join(dataRoot, 'gone'))] = 'proj_ghost';
  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
  const mixed = listProjects(dataRoot);
  assert.equal(mixed.length, 3);
  const bad = mixed.find((row) => row.ok === false);
  assert.equal(bad.projectId, 'proj_ghost');
  assert.match(bad.reason, /^plando：/);
});
