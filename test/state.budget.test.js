// test/state.budget.test.js
// R1c：CONTRACT §3 预算校验与规模判定（checkBudget / computeSize / tech_ok / choose_build）。
// 错误消息只断言关键片段：前缀、`预算`、以及「超了多少 / 怎么降级」两个数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, checkBudget, computeSize, createInitialState, validatePayload } from '../lib/state.js';

const CONFIG = { budget: { mustUnderstand: 5, totalMinutes: 600 } };

function item(over = {}) {
  return {
    id: 't1',
    title: 'Electron 窗口',
    why: '能弹出应用窗口',
    ifMissing: '打不开应用，后面都验证不了',
    owner: 'ai',
    difficulty: 2,
    minutes: 60,
    judge: '双击快捷方式能看到窗口',
    file: 'main.js',
    ...over,
  };
}

function itemsOf(n, over = {}) {
  return Array.from({ length: n }, (_, i) => item({ id: `t${i + 1}`, ...over }));
}

function makeState(over = {}) {
  return { ...createInitialState({ name: '记账工具', dir: 'C:/tmp/proj' }), ...over };
}

// --- checkBudget：user 条数上限 -------------------------------------------

test('checkBudget：user 条数刚好 5 通过', () => {
  const items = itemsOf(5, { owner: 'user', minutes: 10 });
  assert.deepEqual(checkBudget(items, { mustUnderstand: 5, totalMinutes: 600 }), { ok: true });
});

test('checkBudget：user 条数 6 超限，理由含超出条数与降级条数', () => {
  const items = itemsOf(6, { owner: 'user', minutes: 10 });
  const r = checkBudget(items, { mustUnderstand: 5, totalMinutes: 600 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /预算/);
  assert.match(r.reason, /下一步/);
  // 「有 6 条，超出上限 5 条 1 条」+「把 1 条降级」——超了多少、怎么降级两个数都在
  assert.match(r.reason, /6 条/);
  assert.match(r.reason, /1 条/);
  assert.match(r.reason, /降级/);
});

test('checkBudget：totalMinutes 超限，理由含总时长、超时数与要砍的分钟数', () => {
  const skills = [item({ minutes: 400 }), item({ id: 't2', minutes: 400 })];
  const r = checkBudget(skills, { mustUnderstand: 5, totalMinutes: 600 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /预算/);
  assert.match(r.reason, /800 分钟/);
  assert.match(r.reason, /200 分钟/);
  assert.match(r.reason, /砍掉/);
});

test('checkBudget：两项同时超限时理由同时给两组数字', () => {
  const items = [...itemsOf(6, { owner: 'user', minutes: 100 }), item({ id: 't7', minutes: 300 })];
  const r = checkBudget(items, CONFIG.budget);
  assert.equal(r.ok, false);
  assert.match(r.reason, /6 条/);
  assert.match(r.reason, /900 分钟/);
  assert.match(r.reason, /300 分钟/);
});

test('checkBudget：默认预算为 5 / 600（不传 budget 时也生效）', () => {
  assert.equal(checkBudget(itemsOf(5, { owner: 'user', minutes: 100 })).ok, true);
  assert.equal(checkBudget(itemsOf(6, { owner: 'user', minutes: 10 }), {}).ok, false);
  assert.equal(checkBudget(itemsOf(10, { minutes: 61 })).ok, false);
});

test('checkBudget：空清单 / 非数组不炸', () => {
  assert.equal(checkBudget([]).ok, true);
  assert.equal(checkBudget(null).ok, true);
});

test('tech_ok：预算超限被拒（validatePayload 与 applyEvent 都拦）', () => {
  const items = itemsOf(6, { owner: 'user', minutes: 10 });
  const v = validatePayload('tech_ok', { items }, CONFIG);
  assert.equal(v.ok, false);
  assert.match(v.reason, /^plando：/);
  assert.match(v.reason, /预算/);

  const a = applyEvent(makeState({ stage: 'tech' }), 'tech_ok', { items }, CONFIG);
  assert.equal(a.ok, false);
  assert.match(a.reason, /^plando：/);
  // applyEvent 才补阶段名（§5 分层约定）
  assert.match(a.reason, /现在是「技术拆解」阶段/);
  assert.match(a.reason, /预算/);
});

// --- computeSize：超过阈值（默认 300）或 promiseRisk 判 large -----------------

test('computeSize：默认阈值 300，300 分钟仍是 small，301 判 large 且理由带阈值', () => {
  assert.deepEqual(computeSize([item({ minutes: 300 })], {}), { size: 'small', sizeReason: '', totalMinutes: 300 });
  const r = computeSize([item({ minutes: 301 })], {});
  assert.equal(r.size, 'large');
  assert.equal(r.totalMinutes, 301);
  // 理由必须同时给出「实际多少」和「阈值多少」，否则用户不知道为什么被判大。
  assert.match(r.sizeReason, /301 分钟/);
  assert.match(r.sizeReason, /300 分钟阈值/);
});

test('computeSize：阈值可由第三个参数覆盖（对应 config.sizeThresholdMinutes）', () => {
  // 调低阈值：120 分钟就会判 large
  assert.equal(computeSize([item({ minutes: 120 })], {}, 120).size, 'small');
  assert.equal(computeSize([item({ minutes: 121 })], {}, 120).size, 'large');
  // 调高阈值：500 分钟仍是 small
  assert.equal(computeSize([item({ minutes: 500 })], {}, 800).size, 'small');
  // 非法阈值退回默认 300
  for (const bad of [0, -1, 1.5, '300', null, undefined]) {
    assert.equal(computeSize([item({ minutes: 301 })], {}, bad).size, 'large', `阈值 ${JSON.stringify(bad)} 应退回默认`);
  }
});

test('computeSize：constraints.promiseRisk === true 判 large，理由为「承诺风险」', () => {
  const r = computeSize([item({ minutes: 10 })], { promiseRisk: true });
  assert.equal(r.size, 'large');
  assert.equal(r.sizeReason, '承诺风险');
  // 只认严格 true：false / 'true' / 1 都不算承诺风险
  for (const bad of [false, 'true', 1]) {
    assert.equal(computeSize([item({ minutes: 10 })], { promiseRisk: bad }).size, 'small', `promiseRisk=${bad}`);
  }
});

test('computeSize：分钟超限与承诺风险同时成立时，理由优先给分钟数', () => {
  const r = computeSize([item({ minutes: 400 })], { promiseRisk: true });
  assert.equal(r.size, 'large');
  assert.match(r.sizeReason, /400 分钟/);
});

test('computeSize：空清单返回 small / 0 分钟', () => {
  assert.deepEqual(computeSize([], {}), { size: 'small', sizeReason: '', totalMinutes: 0 });
  assert.deepEqual(computeSize(undefined, null), { size: 'small', sizeReason: '', totalMinutes: 0 });
});

// --- tech_ok 写回 size / threshold ----------------------------------------

test('tech_ok：提交后 state.tech.size / sizeReason 由 computeSize 决定', () => {
  const state = makeState({ stage: 'tech' });
  const small = applyEvent(state, 'tech_ok', { items: itemsOf(2, { minutes: 60 }) }, CONFIG);
  assert.equal(small.ok, true);
  assert.equal(small.state.stage, 'decide');
  assert.equal(small.state.tech.size, 'small');
  assert.equal(small.state.tech.threshold, 300, 'tech_ok 要把生效阈值快照进 state');

  const large = applyEvent(state, 'tech_ok', { items: [item({ minutes: 400 })] }, CONFIG);
  assert.equal(large.ok, true);
  assert.equal(large.state.tech.size, 'large');
  assert.match(large.state.tech.sizeReason, /400 分钟/);
});

test('tech_ok：config.sizeThresholdMinutes 覆盖默认阈值，并写进快照', () => {
  const state = makeState({ stage: 'tech' });
  const cfg = { ...CONFIG, sizeThresholdMinutes: 120 };
  const r = applyEvent(state, 'tech_ok', { items: [item({ minutes: 150 })] }, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.state.tech.size, 'large', '阈值 120 时 150 分钟必须判大');
  assert.equal(r.state.tech.threshold, 120);

  // 同一个项目 revise 后重传清单：沿用已有快照，不被新配置改判
  const revised = applyEvent({ ...r.state, stage: 'tech' }, 'tech_ok', { items: [item({ minutes: 150 })] }, { ...CONFIG, sizeThresholdMinutes: 800 });
  assert.equal(revised.ok, true);
  assert.equal(revised.state.tech.threshold, 120, 'revise 重传必须沿用已有阈值快照');
  assert.equal(revised.state.tech.size, 'large');
});

test('createInitialState：传了 sizeThresholdMinutes 就落快照，没传/非法则留空由 tech_ok 取', () => {
  // 真实路径是 initProject 从 readConfig 拿到（默认 300）再传进来，所以正常项目一定有快照。
  assert.equal(createInitialState({ name: 'x', sizeThresholdMinutes: 500 }).tech.threshold, 500);
  // 没传（单测、手写 state、老项目）就留 undefined：交给 tech_ok 按当时的 config 取一次，
  // 而不是在这里悄悄钉成 300——否则「配置 500 但直接 createInitialState」会静默按 300 判。
  assert.equal(createInitialState({ name: 'x' }).tech.threshold, undefined);
  for (const bad of [0, -1, 1.5, '300']) {
    assert.equal(createInitialState({ name: 'x', sizeThresholdMinutes: bad }).tech.threshold, undefined, `阈值 ${JSON.stringify(bad)}`);
  }
});

test('tech_ok：id 由实现按位置分配 t1/t2，显式 id 沿用', () => {
  const r = applyEvent(makeState({ stage: 'tech' }), 'tech_ok', { items: [item(), item({ id: 't9' })] }, CONFIG);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.tech.items.map((i) => i.id), ['t1', 't9']);
});

// --- 预算快照（CONTRACT §4：createInitialState 从 project.budget 写入） -----

test('createInitialState：把 project.budget 写成 state.budget 快照（§4）', () => {
  const state = createInitialState({ name: '记账工具', budget: { mustUnderstand: 3, totalMinutes: 120 } });
  assert.deepEqual(state.budget, { mustUnderstand: 3, totalMinutes: 120 });
});

test('createInitialState：不传 budget 时也应有契约默认快照 5 / 600（§4）', () => {
  assert.deepEqual(createInitialState({ name: '记账工具' }).budget, { mustUnderstand: 5, totalMinutes: 600 });
});

test('applyEvent：预算校验读 state.budget 快照（§4「所有渲染与校验都读 state.budget」）', () => {
  const state = makeState({ stage: 'tech', budget: { mustUnderstand: 1, totalMinutes: 60 } });
  const r = applyEvent(state, 'tech_ok', { items: [item({ minutes: 100 })] }, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /预算/);
});

test('applyEvent：state.budget 快照优先于 config.budget（改配置不影响历史项目）', () => {
  const state = makeState({ stage: 'tech', budget: { mustUnderstand: 1, totalMinutes: 60 } });
  const r = applyEvent(state, 'tech_ok', { items: [item({ minutes: 100 })] }, { budget: { mustUnderstand: 99, totalMinutes: 9999 } });
  assert.equal(r.ok, false, '快照优先：config 放宽了也不能放行');
});

// --- large 且未验证 → choose_build 被拒 ------------------------------------

function decideState(over = {}) {
  return makeState({
    stage: 'decide',
    tech: { items: [item({ minutes: 200 })], size: 'large', sizeReason: '预计 200 分钟' },
    ...over,
  });
}

const BUILD_PAYLOAD = { cards: [{ techIds: ['t1'], title: '把窗口开起来' }] };

test('choose_build：large 且未验证被拒，理由指向先做 choose_verify', () => {
  const r = applyEvent(decideState(), 'choose_build', BUILD_PAYLOAD, CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /large|规模/);
  assert.match(r.reason, /验证/);
  assert.match(r.reason, /choose_verify/);
});

test('choose_build：large 但已验证过（result 合法）则放行', () => {
  const state = decideState({ verify: { hypothesis: 'h', method: 'm', timeboxMin: 30, judge: 'j', result: 'pass', evidence: '跑通了', overtime: false } });
  const r = applyEvent(state, 'choose_build', BUILD_PAYLOAD, CONFIG);
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'build');
  assert.equal(r.state.cards.length, 1);
  assert.equal(r.state.cards[0].status, 'todo');
});

test('choose_build：small 规模无需先验证', () => {
  const state = makeState({
    stage: 'decide',
    tech: { items: [item({ minutes: 60 })], size: 'small', sizeReason: '' },
  });
  const r = applyEvent(state, 'choose_build', BUILD_PAYLOAD, CONFIG);
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'build');
});

test('choose_build：卡片必须覆盖所有 TECH 项', () => {
  const state = makeState({
    stage: 'decide',
    tech: { items: [item({ id: 't1' }), item({ id: 't2', title: '存数据' })], size: 'small', sizeReason: '' },
  });
  const partial = applyEvent(state, 'choose_build', BUILD_PAYLOAD, CONFIG);
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /t2/);

  const full = applyEvent(state, 'choose_build', { cards: [BUILD_PAYLOAD.cards[0], { techIds: ['t2'], title: '把数据存下来' }] }, CONFIG);
  assert.equal(full.ok, true);
  assert.equal(full.state.cards.length, 2);
});
