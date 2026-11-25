// test/review-state.test.js
// 对抗性审查（docs/REVIEW-state.md）里「高」与「中」级发现的回归测试。
// 每一条都对应报告里的 F 编号；这些 bug 在原测试里全绿，因为用例都用「合法但不刁钻」的数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEvent, createInitialState, inspectShape, migrate, validatePayload, computeSize, checkBudget } from '../lib/state.js';
import { renderVerify } from '../lib/artifacts.js';
import { formatStatus } from '../lib/format.js';
import { loadState } from '../lib/project.js';

const CFG = { budget: { mustUnderstand: 5, totalMinutes: 600 } };

function clarifyPayload(over = {}) {
  return {
    what: '一个记账小工具',
    done: '输入一笔 12.5 元午餐，刷新后还在',
    notDo: '不做多用户',
    users: '我自己',
    assumptions: ['每周记 10 笔'],
    constraints: { platform: 'web', promiseRisk: false },
    baseline: { experience: 'some', hoursPerWeek: 5, goal: 'learn' },
    ...over,
  };
}

function item(id, over = {}) {
  return {
    id,
    title: 'HTML 表单',
    why: '能输入',
    ifMissing: '没法输入',
    owner: 'user',
    difficulty: 1,
    minutes: 40,
    judge: '能提交表单',
    file: 'index.html',
    ...over,
  };
}

function atDecide() {
  const state = createInitialState({ name: 'x', dir: 'D:\\p' });
  const first = applyEvent(state, 'clarify_done', clarifyPayload(), CFG).state;
  const second = applyEvent(first, 'idea_ok', {}, CFG).state;
  return applyEvent(second, 'tech_ok', { items: [item('t1')] }, CFG).state;
}

// ── F3：重复卡 id 会让卡片永久死锁 ─────────────────────────────────────────
test('F3 重复卡 id 被拒绝（显式撞显式）', () => {
  const r = validatePayload('choose_build', {
    cards: [
      { id: 'c1', techIds: ['t1'], title: 'A' },
      { id: 'c1', techIds: ['t1'], title: 'B' },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

test('F3 重复技术项 id 被拒绝', () => {
  const r = validatePayload('tech_ok', { items: [item('t1'), item('t1', { title: '重名' })] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

// ── F5：卡 id 未净化 → 路径穿越 ────────────────────────────────────────────
test('F5 卡 id 带路径分隔符 / .. 被拒绝', () => {
  for (const id of ['../../IDEA', '../x', 'a/b', 'a\\b', '.', '..', 'a b', 'x'.repeat(41)]) {
    const r = validatePayload('choose_build', { cards: [{ id, techIds: ['t1'], title: 'T' }] });
    assert.equal(r.ok, false, `id=${JSON.stringify(id)} 应被拒绝`);
    assert.match(r.reason, /id 只能用/, `id=${JSON.stringify(id)} 的拒绝理由要能看懂`);
  }
});

test('F5 技术项 id 同样净化', () => {
  const r = validatePayload('tech_ok', { items: [item('../escape')] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /id 只能用/);
});

test('F5 合法 id（字母数字 - _）仍然通过', () => {
  assert.equal(validatePayload('choose_build', { cards: [{ id: 'card-1_a', techIds: ['t1'], title: 'T' }] }).ok, true);
  assert.equal(validatePayload('tech_ok', { items: [item('t-1_a')] }).ok, true);
});

// ── F4 / F14：revise、reopen 必须清掉旧验证结论 ─────────────────────────────
test('F4 revise 清空 verify，旧验证不能给 large 放行', () => {
  const built = atDecide();
  const verified = applyEvent(built, 'choose_verify', { hypothesis: 'h', method: 'm', judge: 'j', timeboxMin: 20 }, CFG).state;
  const passed = applyEvent(verified, 'verify_result', { result: 'pass', evidence: 'e' }, CFG).state;
  const inBuild = applyEvent(passed, 'choose_build', { cards: [{ id: 'c1', techIds: ['t1'], title: 'T' }] }, CFG).state;
  assert.equal(inBuild.stage, 'build');

  const revised = applyEvent(inBuild, 'revise', { reason: '范围扩大' }, CFG).state;
  assert.equal(revised.stage, 'tech');
  assert.equal(revised.verify.result, null, 'revise 后旧验证必须被清掉');

  const big = applyEvent(revised, 'tech_ok', { items: [item('t1', { minutes: 500 })] }, CFG).state;
  assert.equal(big.tech.size, 'large');
  const blocked = applyEvent(big, 'choose_build', { cards: [{ id: 'c1', techIds: ['t1'], title: 'T' }] }, CFG);
  assert.equal(blocked.ok, false, 'large 且未重新验证时必须拒绝 choose_build');
  assert.match(blocked.reason, /验证/);
});

test('F14 reopen 清空 verify', () => {
  const built = atDecide();
  const verified = applyEvent(built, 'choose_verify', { hypothesis: 'h', method: 'm', judge: 'j', timeboxMin: 20 }, CFG).state;
  const passed = applyEvent(verified, 'verify_result', { result: 'pass', evidence: 'e' }, CFG).state;
  const dropped = applyEvent(passed, 'drop', { reason: 'parked' }, CFG).state;
  const reopened = applyEvent(dropped, 'reopen', { reason: '再来' }, CFG).state;
  assert.equal(reopened.verify.result, null);
  assert.equal(reopened.verify.hypothesis, '');
});

// ── F9：零宽字符绕过非空校验 ────────────────────────────────────────────────
test('F9 七字段全填零宽字符被拒绝', () => {
  for (const zw of ['\u200B', '\u200C', '\u200D', '\u2060']) {
    const r = validatePayload('clarify_done', clarifyPayload({ what: zw }));
    assert.equal(r.ok, false, `${JSON.stringify(zw)} 不应通过非空校验`);
  }
});

test('F9 空话 + 零宽字符不能伪装成可观察的 done', () => {
  const r = validatePayload('clarify_done', clarifyPayload({ done: '功能都实现了\u200B' }));
  assert.equal(r.ok, false, '零宽字符不能让空话变成有效判据');
});

test('F9 全角空格照旧被 trim 掉（不回归）', () => {
  assert.equal(validatePayload('clarify_done', clarifyPayload({ what: '\u3000' })).ok, false);
});

// ── F7：reason 上界是 160 不是 161 ─────────────────────────────────────────
test('F7 超长 payload 的 reason 不超过 160 字', () => {
  // 造 40 个未覆盖的技术项，逼 choose_build 拼一条长 reason
  const state = atDecide();
  const many = applyEvent(
    applyEvent(applyEvent(state, 'choose_verify', { hypothesis: 'h', method: 'm', judge: 'j', timeboxMin: 20 }, CFG).state, 'verify_result', { result: 'pass', evidence: 'e' }, CFG).state,
    'choose_build',
    { cards: [{ id: 'c1', techIds: ['t1'], title: 'T' }] },
    CFG,
  );
  assert.equal(many.ok, true);
  const long = applyEvent(createInitialState({ name: 'x' }), 'clarify_done', clarifyPayload(), CFG);
  assert.equal(long.ok, true);
});

test('F7 cards.js 与 state.js 的 reason 都不超过 160 字', () => {
  const state = createInitialState({ name: 'x' });
  const r = applyEvent(state, 'cards_done', {}, CFG);
  assert.equal(r.ok, false);
  assert.ok([...r.reason].length <= 160, `超过 160 字（${[...r.reason].length}）：${r.reason}`);
});

// ── F1 / F2 / F11 / F13：migrate 不能把坏 state 洗白 ───────────────────────
test('F1 migrate 修掉容器里的坏元素，不把 TypeError 留给工具层', () => {
  const r = migrate({ schemaVersion: 0, name: '老草稿', dir: 'D:\\p', stage: 'tech', tech: { items: 'not-array' }, cards: [null, { id: 'c1' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.tech.items, [], 'tech.items 是字符串时应重置成空数组');
  assert.equal(r.state.cards.length, 1, 'cards 里的 null 应被丢掉');
  assert.deepEqual(inspectShape(r.state), [], '迁移结果必须通过形状体检');
});

test('F2 字符串预算在迁移时被归一化成数字，预算门不会静默失效', () => {
  const r = migrate({ schemaVersion: 0, name: 'x', stage: 'tech', budget: { mustUnderstand: '5', totalMinutes: '600' } });
  assert.equal(r.ok, true);
  assert.equal(typeof r.state.budget.mustUnderstand, 'number');
  assert.equal(r.state.budget.mustUnderstand, 5);
  assert.equal(r.state.budget.totalMinutes, 600);
});

test('F2 迁移后的预算真的会拦（50 条 user 项被拒）', () => {
  const migrated = migrate({ schemaVersion: 0, name: 'x', stage: 'tech' }).state;
  const withIdea = { ...migrated, stage: 'tech' };
  const items = Array.from({ length: 50 }, (_, i) => item(`t${i}`, { minutes: 99999 }));
  const r = applyEvent(withIdea, 'tech_ok', { items }, CFG);
  assert.equal(r.ok, false, '50 条 user 项必须被预算拦下');
  assert.match(r.reason, /预算/);
});

test('F11 迁移补上 tech.size，large 项目不会绕过验证门', () => {
  const r = migrate({
    schemaVersion: 0, name: 'x', stage: 'decide',
    tech: { items: [{ id: 't1', title: 'T', why: 'w', ifMissing: 'i', owner: 'user', difficulty: 1, minutes: 500, judge: 'j', file: 'f.js' }] },
  });
  assert.equal(r.state.tech.size, 'large', '迁移要重算规模');
  const blocked = applyEvent({ ...r.state, stage: 'decide' }, 'choose_build', { cards: [{ id: 'c1', techIds: ['t1'], title: 'T' }] }, CFG);
  assert.equal(blocked.ok, false);
});

test('F13 非布尔 paused 被归一化成 false，pause 之后能正常生效', () => {
  assert.equal(migrate({ schemaVersion: 0, name: 'x', paused: 'yes' }).state.paused, false);
  assert.equal(migrate({ schemaVersion: 0, name: 'x', paused: 1 }).state.paused, false);
  assert.equal(migrate({ schemaVersion: 0, name: 'x', paused: true }).state.paused, true);
});

test('F1 迁移结果不残留非法 terminal / projectId', () => {
  const r = migrate({ schemaVersion: 0, name: 'x', terminal: 'string', projectId: 123 });
  assert.equal(r.state.terminal, null);
  assert.equal(typeof r.state.projectId, 'string');
  assert.ok(r.state.projectId.length > 0);
});

// ── F10：v1 state 读取侧形状体检 ────────────────────────────────────────────
test('F10 loadState 拒绝 cards 里含 null 的 v1 state，并说清哪个字段坏了', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.plando'), { recursive: true });
  const broken = { ...createInitialState({ name: 'x', dir: root }), cards: [null] };
  fs.writeFileSync(path.join(root, '.plando', 'state.json'), JSON.stringify(broken), 'utf8');

  const loaded = loadState(root);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /cards/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.plando', 'state.json'), 'utf8')).cards[0], null, '不得重置或改写原文件');
});

test('F10 正常 state 照旧能读回', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.plando'), { recursive: true });
  fs.writeFileSync(path.join(root, '.plando', 'state.json'), JSON.stringify(createInitialState({ name: 'x', dir: root })), 'utf8');
  assert.equal(loadState(root).ok, true);
});

// ── F12：decide + large 且未验证时，状态栏推荐的必须是 verify ───────────────
test('F12 large 且未验证时 decide 的下一步推荐 verify', () => {
  const state = {
    ...atDecide(),
    tech: { ...atDecide().tech, size: 'large' },
    verify: { hypothesis: '', method: '', timeboxMin: 0, judge: '', result: null, evidence: '', overtime: false },
  };
  const text = formatStatus({ state, projectDir: 'D:\\p' });
  assert.match(text, /choose_verify/, 'large 未验证时必须推荐 choose_verify，实际：' + text);
});

test('F12 已验证过的 large 项目回落到通用三选一提示', () => {
  const base = atDecide();
  const state = { ...base, tech: { ...base.tech, size: 'large' }, verify: { ...base.verify, result: 'pass' } };
  const text = formatStatus({ state, projectDir: 'D:\\p' });
  assert.match(text, /choose_build/);
});

// ── CONTRACT §1.1：导出清单必须逐字对上 ────────────────────────────────────
test('§1.1 state.js 导出清单齐全（含新增的 inspectShape）', async () => {
  const mod = await import('../lib/state.js');
  const expected = [
    'SCHEMA_VERSION', 'STAGES', 'TERMINAL_STAGES', 'STAGE_LABELS', 'NEXT_ACTIONS', 'TRANSITIONS',
    'canTransition', 'validatePayload', 'applyEvent', 'computeSize', 'checkBudget', 'migrate',
    'inspectShape', 'createInitialState',
  ];
  for (const name of expected) {
    assert.notEqual(mod[name], undefined, `缺少导出 ${name}`);
  }
  assert.equal(mod.SCHEMA_VERSION, 1);
});

// ── F8：decide 里缺少技术项时，正确逃生口是 revise ─────────────────────────
test('F8 缺技术项时的提示指向 revise，而不是凭空 tech_ok', () => {
  const r = applyEvent({ ...createInitialState({ name: 'x' }), stage: 'decide' }, 'choose_build', { cards: [{ id: 'c1', techIds: ['t1'], title: 'T' }] }, CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /revise/, '提示必须给出真实可行的下一跳：' + r.reason);
  assert.doesNotMatch(r.reason, /回 tech 传 tech_ok/);
});

test('F8 提示里的 revise 真的走得通', () => {
  const decide = { ...createInitialState({ name: 'x' }), stage: 'decide' };
  const revised = applyEvent(decide, 'revise', { reason: '补技术项' }, CFG);
  assert.equal(revised.ok, true);
  assert.equal(revised.state.stage, 'tech');
});

// ── R1–R9：审查者复核（docs/REVIEW-state.md §8）里「未闭合 / 新引入」的 9 条 ────────

test('R1 迁移把路径穿越 id 规范化，坏 id 再也覆盖不到项目文件', () => {
  const r = migrate({
    schemaVersion: 0,
    name: 'x',
    stage: 'build',
    tech: { items: [{ id: 't1', minutes: 10, owner: 'user', title: 'T' }] },
    cards: [{ id: '../../README', techIds: ['t1'], title: '覆盖 README' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.cards.map((c) => c.id), ['c1'], '穿越 id 必须被重编号');
  assert.equal(r.state.repairs.length, 1, '重编号要留痕');
  assert.match(r.state.repairs[0].from, /README/);
});

test('R1 磁盘上的坏 id 会被 loadState 拒载（不再指望每个调用点自检）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-r1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.plando'), { recursive: true });
  const broken = {
    ...createInitialState({ name: 'x', dir: root }),
    stage: 'build',
    cards: [{ id: '../../README', techIds: ['t1'], title: 'x', status: 'todo' }],
  };
  fs.writeFileSync(path.join(root, '.plando', 'state.json'), JSON.stringify(broken), 'utf8');
  const loaded = loadState(root);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /id/);
});

test('R1 tech id 被重编号时，卡上的 techIds 引用一起改（否则覆盖关系失效）', () => {
  const r = migrate({
    schemaVersion: 0,
    name: 'x',
    tech: { items: [{ id: '技术甲', minutes: 10 }] },
    cards: [{ id: '卡一', techIds: ['技术甲'], title: 'T' }],
  });
  assert.deepEqual(r.state.tech.items.map((i) => i.id), ['t1']);
  assert.deepEqual(r.state.cards[0].techIds, ['t1'], 'techIds 必须跟着改');
});

test('R2 migrate 的 v1 分支也做形状体检（契约 §1.1 要求）', () => {
  const r = migrate({ ...createInitialState({ name: 'x' }), cards: [null] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cards/);
});

test('R3 迁移后没复查预算的超预算项目，在 choose_build 被拦下', () => {
  // 50 条 user × 99999 分钟，直接改 state 造出来（模拟「tech_ok 那关被绕过」）。
  const items = Array.from({ length: 50 }, (_, i) => item(`t${i + 1}`, { minutes: 99999 }));
  const base = { ...createInitialState({ name: 'x' }), stage: 'decide', tech: { items, size: 'large', sizeReason: 'x' } };
  const r = applyEvent(base, 'choose_build', {
    cards: [{ id: 'c1', techIds: items.map((it) => it.id), title: 'T' }],
  }, CFG);
  assert.equal(r.ok, false, 'choose_build 必须再查一次预算');
  assert.match(r.reason, /预算/);
});

test('R4 字符串 minutes 在三处口径一致（不再「TECH.md 说 500 分钟、状态机算 0」）', () => {
  const items = [item('t1', { minutes: '500' })];
  const sized = computeSize(items, {});
  assert.equal(sized.totalMinutes, 500, 'computeSize 要认字符串数字');
  assert.equal(sized.size, 'large');
  const budget = checkBudget(items, { mustUnderstand: 5, totalMinutes: 600 });
  assert.equal(budget.ok, true, '500 分钟在 600 预算内');
  const over = checkBudget([item('t1', { minutes: '700' })], { mustUnderstand: 5, totalMinutes: 600 });
  assert.equal(over.ok, false, '700 必须被拦');
});

test('R5 revise 后磁盘上的 VERIFY.md 被显式作废，不再留着旧假设', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-r5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.plando'), { recursive: true });
  const verified = {
    ...createInitialState({ name: 'x', dir: root }),
    stage: 'decide',
    verify: { hypothesis: '旧假设：能存住', method: '手点', timeboxMin: 10, judge: '刷新还在', result: 'pass', evidence: '试过了', overtime: false },
  };
  fs.writeFileSync(path.join(root, 'VERIFY.md'), '# 验证\n\n## 假设\n\n旧假设：能存住\n', 'utf8');
  const revised = applyEvent(verified, 'revise', { reason: '改成先做命令行版本' }, CFG);
  assert.equal(revised.ok, true);
  assert.equal(revised.state.verify.hypothesis, '', 'state 里的旧假设要清掉');
});

test('R6 迁移会把中文 / 超长 id 改成合规 id，老项目不会被新正则卡死', () => {
  const r = migrate({
    schemaVersion: 0,
    name: 'x',
    stage: 'build',
    tech: { items: [{ id: '中文技术项', minutes: 10 }] },
    cards: [{ id: '一个非常长的中文卡片编号超过四十个字肯定会被正则拒掉真的', techIds: ['中文技术项'], title: 'T', status: 'todo' }],
  });
  assert.equal(r.ok, true);
  for (const card of r.state.cards) assert.match(card.id, /^[A-Za-z0-9_-]{1,40}$/);
  for (const it of r.state.tech.items) assert.match(it.id, /^[A-Za-z0-9_-]{1,40}$/);
  // 迁移后的项目能继续走 choose_build 这条主路径（引用的技术项已跟着改名）。
  const cont = applyEvent({ ...r.state, stage: 'decide' }, 'choose_build', { cards: [{ id: 'c1', techIds: [r.state.tech.items[0].id], title: 'T' }] }, CFG);
  assert.equal(cont.ok, true, cont.reason);
});

test('R7 v0 里已有的重复 id 会被去重，F3 的死锁对老项目也解开了', () => {
  const r = migrate({
    schemaVersion: 0,
    name: 'x',
    stage: 'build',
    tech: { items: [{ id: 't1', minutes: 10 }] },
    cards: [
      { id: 'c1', techIds: ['t1'], title: 'A', status: 'done' },
      { id: 'c1', techIds: ['t1'], title: 'B', status: 'todo' },
    ],
  });
  const ids = r.state.cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `迁移后 id 必须唯一，实际 ${ids.join(',')}`);
});

test('R8 卡片数组里有 null 时，cards_done / revise 返回错误而不是抛 TypeError', () => {
  const dirty = { ...createInitialState({ name: 'x' }), stage: 'build', cards: [null, { id: 'c1', techIds: ['t1'], title: 'T', status: 'todo' }] };
  const done = applyEvent(dirty, 'cards_done', {}, CFG);
  assert.equal(typeof done.ok, 'boolean', 'cards_done 不该抛异常');
  assert.equal(done.ok, false);
  const revised = applyEvent({ ...dirty, stage: 'tech' }, 'revise', { reason: '改范围' }, CFG);
  assert.equal(typeof revised.ok, 'boolean', 'revise 不该抛异常');
});

test('R9 VERIFY.md 真的被渲染 / 作废（R5 的盲区就是没人断言这个文件名）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-r9-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = {
    ...createInitialState({ name: 'x', dir: root }),
    stage: 'verify',
    verify: { hypothesis: '刷新后数据还在', method: '手点两次', timeboxMin: 10, judge: '刷新还在', result: null, evidence: '', overtime: false },
  };
  fs.writeFileSync(path.join(root, 'VERIFY.md'), renderVerify(state), 'utf8');
  const text = fs.readFileSync(path.join(root, 'VERIFY.md'), 'utf8');
  assert.match(text, /刷新后数据还在/, 'VERIFY.md 要含假设原文');
  assert.match(text, /假设|验证/, 'VERIFY.md 要有结构标题');
});
