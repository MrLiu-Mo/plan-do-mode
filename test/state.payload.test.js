// test/state.payload.test.js
// R1c：CONTRACT §3 payload 校验（validatePayload 与 state 无关，reason 只断言前缀 + 「下一步」）。
// 分层约定见 CONTRACT §5：validatePayload 的 reason 不含阶段名；要断言阶段名请走 applyEvent。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, validatePayload } from '../lib/state.js';

// 契约 §5 统一形状：`plando：…——下一步：…`
function assertReasonShape(r) {
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /下一步/);
  assert.doesNotMatch(r.reason, /现在是「/, 'validatePayload 的 reason 不应含阶段名');
  assert.ok([...r.reason].length <= 160, `reason 超过 160 字：${r.reason}`);
}

function clarify(over = {}) {
  return {
    what: '一个只能记一笔账的小工具',
    done: '能点开页面，输入一笔账后列表里出现它',
    notDo: '不做多用户',
    users: '我自己',
    assumptions: ['我每周会记 3 次账'],
    constraints: { budget: '0 元', platform: 'Windows' },
    baseline: { experience: 'beginner', hoursPerWeek: 5, goal: 'ship' },
    ...over,
  };
}

const ITEM = {
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

const CONFIG = { budget: { mustUnderstand: 5, totalMinutes: 600 } };

// --- clarify_done：七个必填字段各缺一次 -------------------------------------

const CLARIFY_FIELDS = ['what', 'done', 'notDo', 'users', 'assumptions', 'constraints', 'baseline'];

for (const field of CLARIFY_FIELDS) {
  test(`clarify_done：缺 ${field} 被拒`, () => {
    const p = clarify();
    delete p[field];
    assertReasonShape(validatePayload('clarify_done', p));
  });
}

test('clarify_done：七个字段齐全时通过', () => {
  assert.deepEqual(validatePayload('clarify_done', clarify()), { ok: true });
});

test('clarify_done：assumptions 为空数组被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ assumptions: [] })));
});

test('clarify_done：assumptions 含空项被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ assumptions: ['  '] })));
});

test('clarify_done：done 只写「功能都实现了」之外的空话被拒', () => {
  for (const vague of ['实现了', '完成了', '功能齐全', '都做完了', '完成了，功能齐全']) {
    assertReasonShape(validatePayload('clarify_done', clarify({ done: vague })));
  }
});

test('clarify_done：done 只写「功能都实现了」应被拒（§3 注释点名了这一句）', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ done: '功能都实现了' })));
});

test('clarify_done：done 由空话词拼成的句子一律被拒（含填充词组合）', () => {
  for (const vague of ['功能全部实现了', '所有功能都做完了', '基本搞定了', '已经完成了功能']) {
    assertReasonShape(validatePayload('clarify_done', clarify({ done: vague })));
  }
});

test('clarify_done：「能点开页面，实现了」通过（可观察现象 + 空话）', () => {
  assert.equal(validatePayload('clarify_done', clarify({ done: '能点开页面，实现了' })).ok, true);
});

test('clarify_done：done 超过 200 字被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ done: '能'.repeat(201) })));
  assert.equal(validatePayload('clarify_done', clarify({ done: '能'.repeat(200) })).ok, true);
});

test('clarify_done：constraints 不是对象被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ constraints: [] })));
});

// --- clarify_done.baseline 三字段与越界 ------------------------------------

test('clarify_done：baseline.experience 非法被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ baseline: { experience: 'expert', hoursPerWeek: 5, goal: 'learn' } })));
});

test('clarify_done：baseline.goal 非法被拒', () => {
  assertReasonShape(validatePayload('clarify_done', clarify({ baseline: { experience: 'some', hoursPerWeek: 5, goal: 'fun' } })));
});

test('clarify_done：baseline.hoursPerWeek 越界 / 非数字被拒，1 与 60 通过', () => {
  for (const h of [0, 61, -1, '5']) {
    assertReasonShape(validatePayload('clarify_done', clarify({ baseline: { experience: 'some', hoursPerWeek: h, goal: 'learn' } })));
  }
  for (const h of [1, 60]) {
    const b = { experience: 'some', hoursPerWeek: h, goal: 'learn' };
    assert.equal(validatePayload('clarify_done', clarify({ baseline: b })).ok, true, `hoursPerWeek=${h} 应合法`);
  }
});

// --- tech_ok：每项 9 字段（id 可省略，其余 8 个必填）+ 枚举 + 预算 ----------

const ITEM_FIELDS = ['title', 'why', 'ifMissing', 'owner', 'difficulty', 'minutes', 'judge', 'file'];

for (const field of ITEM_FIELDS) {
  test(`tech_ok：技术项缺 ${field} 被拒`, () => {
    const item = { ...ITEM };
    delete item[field];
    assertReasonShape(validatePayload('tech_ok', { items: [item] }, CONFIG));
  });
}

test('tech_ok：id 可省略（由实现分配），显式 id 为空串被拒', () => {
  const noId = { ...ITEM };
  delete noId.id;
  assert.equal(validatePayload('tech_ok', { items: [noId] }, CONFIG).ok, true);
  assertReasonShape(validatePayload('tech_ok', { items: [{ ...ITEM, id: '' }] }, CONFIG));
});

test('tech_ok：owner 非法被拒', () => {
  assertReasonShape(validatePayload('tech_ok', { items: [{ ...ITEM, owner: 'me' }] }, CONFIG));
});

test('tech_ok：difficulty 越界被拒，1 / 2 / 3 通过', () => {
  for (const d of [0, 4, '2']) {
    assertReasonShape(validatePayload('tech_ok', { items: [{ ...ITEM, difficulty: d }] }, CONFIG));
  }
  for (const d of [1, 2, 3]) {
    assert.equal(validatePayload('tech_ok', { items: [{ ...ITEM, difficulty: d }] }, CONFIG).ok, true, `difficulty=${d} 应合法`);
  }
});

test('tech_ok：minutes 必须是正整数', () => {
  for (const m of [0, -5, 1.5, '60']) {
    assertReasonShape(validatePayload('tech_ok', { items: [{ ...ITEM, minutes: m }] }, CONFIG));
  }
});

test('tech_ok：items 为空或缺失被拒', () => {
  assertReasonShape(validatePayload('tech_ok', { items: [] }, CONFIG));
  assertReasonShape(validatePayload('tech_ok', {}, CONFIG));
});

// --- choose_verify：timeboxMin 边界 ---------------------------------------

const VERIFY_BASE = { hypothesis: 'Electron 能开窗', method: '跑一次空窗口', judge: '看到窗口就算过' };

test('choose_verify：timeboxMin 0 / 61 / 小数 / 字符串被拒', () => {
  for (const t of [0, 61, -1, 30.5, '30']) {
    assertReasonShape(validatePayload('choose_verify', { ...VERIFY_BASE, timeboxMin: t }));
  }
});

test('choose_verify：timeboxMin 1 / 60 通过，缺字段被拒', () => {
  for (const t of [1, 60]) {
    assert.equal(validatePayload('choose_verify', { ...VERIFY_BASE, timeboxMin: t }).ok, true, `timeboxMin=${t} 应合法`);
  }
  const p = { ...VERIFY_BASE, timeboxMin: 30 };
  delete p.hypothesis;
  assertReasonShape(validatePayload('choose_verify', p));
});

// --- verify_result --------------------------------------------------------

test('verify_result：result 非法值被拒，三个合法值通过', () => {
  for (const bad of ['ok', 'passed', 'PASS', '', null]) {
    assertReasonShape(validatePayload('verify_result', { result: bad, evidence: '点了 3 次' }));
  }
  for (const good of ['pass', 'fail', 'inconclusive']) {
    assert.equal(validatePayload('verify_result', { result: good, evidence: '点了 3 次' }).ok, true, `${good} 应合法`);
  }
});

test('verify_result：evidence 为空被拒', () => {
  assertReasonShape(validatePayload('verify_result', { result: 'pass', evidence: '   ' }));
});

// --- choose_build / ship_pass / revise / reopen 的形状 ---------------------

test('choose_build：cards 为空或卡缺标题被拒', () => {
  assertReasonShape(validatePayload('choose_build', { cards: [] }));
  assertReasonShape(validatePayload('choose_build', { cards: [{ techIds: ['t1'] }] }));
});

test('ship_pass：三项都真才过', () => {
  assertReasonShape(validatePayload('ship_pass', { offlineOk: false, selfChange: true, explain: 'x' }));
  assertReasonShape(validatePayload('ship_pass', { offlineOk: true, selfChange: false, explain: 'x' }));
  assertReasonShape(validatePayload('ship_pass', { offlineOk: true, selfChange: true, explain: ' ' }));
  assert.equal(validatePayload('ship_pass', { offlineOk: true, selfChange: true, explain: '我改了配色' }).ok, true);
});

test('revise / reopen：reason 非空', () => {
  assertReasonShape(validatePayload('revise', {}));
  assertReasonShape(validatePayload('reopen', { reason: '' }));
  assert.equal(validatePayload('reopen', { reason: '再来一次' }).ok, true);
});

test('不认识的事件名：validatePayload 也报错并指向事件表', () => {
  const r = validatePayload('nope', {});
  assertReasonShape(r);
  assert.match(r.reason, /事件/);
});

// --- 分层约定：applyEvent 才补阶段名 ---------------------------------------

test('applyEvent 会用阶段名包装 validatePayload 的错误（§5 分层）', () => {
  const state = { stage: 'clarify' };
  const r = applyEvent(state, 'clarify_done', clarify({ what: '' }), CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /现在是「澄清中」阶段/);
  assert.match(r.reason, /下一步/);
});
