// test/state.transitions.test.js
// R1c：CONTRACT §2 事件表的合法 / 非法转移、幂等与间接约束。
// 约定：每个用例自己 makeState()；错误消息只用正则断言片段，不断言整句文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent,
  canTransition,
  createInitialState,
  STAGES,
  STAGE_LABELS,
  NEXT_ACTIONS,
  TERMINAL_STAGES,
  TRANSITIONS,
} from '../lib/state.js';

const ISO = '2026-11-25T00:00:00.000Z';

function makeState(over = {}) {
  return { ...createInitialState({ name: '记账工具', dir: 'C:/tmp/proj' }), ...over };
}

const TECH_ITEM = {
  id: 't1',
  title: 'Electron 窗口',
  why: '能弹出应用窗口',
  ifMissing: '打不开应用，后面都验证不了',
  owner: 'ai',
  difficulty: 2,
  minutes: 60,
  judge: '双击快捷方式能看到窗口',
  file: 'main.js',
};

const fullIdea = () => ({
  id: '',
  title: '记账工具',
  oneLine: '一个只能记一笔账的小工具',
  users: '我自己',
  mvp: ['能输入一笔账'],
  acceptance: ['能点开页面，输入一笔账后列表里出现它'],
  notDo: ['不做多用户'],
  assumptions: ['我每周会记 3 次账'],
  constraints: { platform: 'Windows' },
});

function clarifyPayload(over = {}) {
  return {
    what: '一个只能记一笔账的小工具',
    done: '能点开页面，输入一笔账后列表里出现它',
    notDo: '不做多用户',
    users: '我自己',
    assumptions: ['我每周会记 3 次账'],
    constraints: { platform: 'Windows' },
    baseline: { experience: 'beginner', hoursPerWeek: 5, goal: 'ship' },
    ...over,
  };
}

const decideState = () => makeState({ stage: 'decide', tech: { items: [{ ...TECH_ITEM }], size: 'small', sizeReason: '' } });

// §2 每一行的合法用例：期望目标阶段与关键副作用。
const LEGAL = [
  { event: 'clarify_done', payload: clarifyPayload(), make: () => makeState({ stage: 'clarify' }), to: 'idea' },
  { event: 'idea_ok', payload: {}, make: () => makeState({ stage: 'idea', idea: fullIdea() }), to: 'tech' },
  { event: 'tech_ok', payload: { items: [{ ...TECH_ITEM }] }, make: () => makeState({ stage: 'tech' }), to: 'decide' },
  {
    event: 'choose_verify',
    payload: { hypothesis: 'Electron 能开窗', method: '跑一次空窗口', timeboxMin: 30, judge: '看到窗口就算过' },
    make: () => makeState({ stage: 'decide' }),
    to: 'verify',
  },
  { event: 'choose_build', payload: { cards: [{ techIds: ['t1'], title: '把窗口开起来' }] }, make: decideState, to: 'build' },
  { event: 'choose_handoff', payload: {}, make: () => makeState({ stage: 'decide' }), to: 'handoff' },
  {
    event: 'verify_result',
    payload: { result: 'pass', evidence: '点了 3 次都能开窗' },
    make: () => makeState({ stage: 'verify' }),
    to: 'decide',
  },
  {
    event: 'cards_done',
    payload: {},
    make: () => makeState({ stage: 'build', cards: [{ id: 'c1', techIds: ['t1'], title: '开窗口', status: 'done' }] }),
    to: 'ship',
  },
  {
    event: 'ship_pass',
    payload: { offlineOk: true, selfChange: true, explain: '我把主色改成了深色' },
    make: () => makeState({ stage: 'ship' }),
    to: 'done',
  },
  { event: 'drop', payload: { reason: 'parked' }, make: () => makeState({ stage: 'build' }), to: 'dropped' },
  { event: 'revise', payload: { reason: '想换个做法' }, make: () => makeState({ stage: 'tech' }), to: 'tech' },
  { event: 'pause', payload: {}, make: () => makeState({ stage: 'clarify' }), to: 'clarify' },
  { event: 'resume', payload: {}, make: () => makeState({ stage: 'clarify', paused: true }), to: 'clarify' },
  {
    event: 'reopen',
    payload: { reason: '想再试一次' },
    make: () => makeState({ stage: 'done', terminal: { kind: 'done', reason: '', at: ISO } }),
    to: 'decide',
  },
];

for (const row of LEGAL) {
  test(`§2 ${row.event}：合法阶段可推进到 ${row.to}`, () => {
    const before = row.make();
    const snapshot = JSON.stringify(before);
    const r = applyEvent(before, row.event, row.payload, { budget: { mustUnderstand: 5, totalMinutes: 600 } });
    assert.equal(r.ok, true, `应成功，实际：${r.reason}`);
    assert.equal(r.state.stage, row.to);
    assert.notEqual(r.state, before, 'applyEvent 必须返回新对象');
    assert.equal(JSON.stringify(before), snapshot, 'applyEvent 不得修改传入的 state');
  });
}

// §2 每一行「错误阶段调用」的非法用例。
const ILLEGAL = [
  { event: 'clarify_done', payload: clarifyPayload(), from: 'build' },
  { event: 'idea_ok', payload: {}, from: 'clarify' },
  { event: 'tech_ok', payload: { items: [{ ...TECH_ITEM }] }, from: 'idea' },
  {
    event: 'choose_verify',
    payload: { hypothesis: 'h', method: 'm', timeboxMin: 30, judge: 'j' },
    from: 'tech',
  },
  { event: 'choose_build', payload: { cards: [{ techIds: ['t1'], title: 'x' }] }, from: 'tech' },
  { event: 'choose_handoff', payload: {}, from: 'tech' },
  { event: 'verify_result', payload: { result: 'pass', evidence: 'e' }, from: 'decide' },
  { event: 'cards_done', payload: {}, from: 'decide' },
  { event: 'ship_pass', payload: { offlineOk: true, selfChange: true, explain: 'x' }, from: 'build' },
  { event: 'drop', payload: { reason: 'parked' }, from: 'done' },
  { event: 'revise', payload: { reason: 'r' }, from: 'clarify' },
  { event: 'pause', payload: {}, from: 'done' },
  { event: 'resume', payload: {}, from: 'dropped' },
  { event: 'reopen', payload: { reason: 'r' }, from: 'clarify' },
];

for (const row of ILLEGAL) {
  test(`§2 ${row.event}：在 ${row.from} 阶段调用被拒并带下一步`, () => {
    const r = applyEvent(makeState({ stage: row.from }), row.event, row.payload);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^plando：/);
    assert.match(r.reason, /下一步/);
  });
}

test('resume：未暂停时返回 {ok:true,noop:true} 且不带 state', () => {
  const r = applyEvent(makeState({ stage: 'clarify', paused: false }), 'resume', {});
  assert.deepEqual(r, { ok: true, noop: true });
  assert.equal('state' in r, false);
});

test('pause：已暂停时同样 noop 且不改状态', () => {
  const before = makeState({ stage: 'build', paused: true });
  const r = applyEvent(before, 'pause', {});
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal('state' in r, false);
});

test('pause：正常暂停置 paused=true 且阶段不变', () => {
  const r = applyEvent(makeState({ stage: 'tech' }), 'pause', {});
  assert.equal(r.ok, true);
  assert.equal(r.state.paused, true);
  assert.equal(r.state.stage, 'tech');
});

test('reopen：清 terminal、清 paused、推进到 decide', () => {
  const r = applyEvent(
    makeState({ stage: 'dropped', paused: true, terminal: { kind: 'dropped', reason: 'parked', at: ISO } }),
    'reopen',
    { reason: '重新开始' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.state.terminal, null);
  assert.equal(r.state.paused, false);
  assert.equal(r.state.stage, 'decide');
});

test('非法事件名：报错、指向事件表', () => {
  const r = applyEvent(makeState({ stage: 'clarify' }), 'nope', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /下一步/);
  assert.match(r.reason, /事件/);
});

test('event=pick 必须报错并指向 plando_idea action=pick', () => {
  const r = applyEvent(makeState({ stage: 'inbox' }), 'pick', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /plando_idea action=pick/);
});

test('drop：reason 只接受 falsified / parked', () => {
  for (const reason of ['falsified', 'parked']) {
    const r = applyEvent(makeState({ stage: 'clarify' }), 'drop', { reason });
    assert.equal(r.ok, true, `${reason} 应合法`);
    assert.equal(r.state.stage, 'dropped');
    assert.equal(r.state.terminal.kind, 'dropped');
    assert.equal(r.state.terminal.reason, reason);
  }
  const bad = applyEvent(makeState({ stage: 'clarify' }), 'drop', { reason: '不想做了' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /falsified/);
  assert.match(bad.reason, /parked/);
});

test('reopen：reason 为空被拒', () => {
  const r = applyEvent(makeState({ stage: 'done', terminal: { kind: 'done', reason: '', at: ISO } }), 'reopen', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /下一步/);
});

test('revise：受影响卡标 stale 并给出 invalidateCards 提示', () => {
  const r = applyEvent(
    makeState({
      stage: 'build',
      cards: [{ id: 'c1', techIds: ['t1'], title: '开窗口', status: 'done' }],
    }),
    'revise',
    { reason: '换 Electron 版本' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.state.cards[0].status, 'stale');
  assert.deepEqual(r.effects.invalidateCards, ['c1']);
});

test('canTransition 是纯查表：与 payload 无关，终态一律不可推进', () => {
  assert.equal(canTransition(makeState({ stage: 'clarify' }), 'clarify_done'), true);
  assert.equal(canTransition(makeState({ stage: 'build' }), 'clarify_done'), false);
  assert.equal(canTransition(makeState({ stage: 'clarify' }), 'pick'), false);
  for (const s of TERMINAL_STAGES) {
    assert.equal(canTransition(makeState({ stage: s }), 'pause'), false, `${s} 不该可 pause`);
    assert.equal(canTransition(makeState({ stage: s }), 'resume'), false, `${s} 不该可 resume`);
    assert.equal(canTransition(makeState({ stage: s }), 'reopen'), true, `${s} 应可 reopen`);
  }
});

test('§2 表覆盖 14 个事件，且 STAGES / 标签 / 下一步齐备', () => {
  assert.equal(Object.keys(TRANSITIONS).length, 14);
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), LEGAL.map((r) => r.event).sort());
  assert.equal(STAGES.length, 11);
  for (const s of STAGES) {
    assert.equal(typeof STAGE_LABELS[s], 'string', `${s} 缺标签`);
    assert.equal(typeof NEXT_ACTIONS[s], 'string', `${s} 缺下一步`);
  }
});
