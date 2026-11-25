// test/cards.test.js —— lib/cards.js：拆卡 / 开工 / 收尾 / 降级 / 进度 / 纯函数不可变。
// 全部是纯函数测试，不写盘；state 用最小可用的手工对象。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCards, startCard, setLearn, setDo, doneCard, downgradeCard, cardProgress,
} from '../lib/cards.js';

// 最小 state：只要 cards 数组就是本模块关心的全部。
function stateWith(cards) {
  return { schemaVersion: 1, stage: 'build', cards: cards ? cards.map((c) => ({ ...c })) : [] };
}

function card(id, status = 'todo') {
  return {
    id, techIds: ['t1'], title: `卡 ${id}`, status,
    learn: null, do: null, verify: null, evidence: null, startedAt: null, doneAt: null,
  };
}

// 先拆一张卡并开工，返回 state；后续用例复用。
function doing() {
  const created = createCards(stateWith([]), [{ techIds: ['t1'], title: '写页面' }]);
  assert.equal(created.ok, true, created.reason);
  const started = startCard(created.state, 'c1');
  assert.equal(started.ok, true, started.reason);
  return started.state;
}

test('createCards：分配 c1、c2…，status 初始 todo，字段齐全', () => {
  const r = createCards(stateWith([]), [
    { techIds: ['t1'], title: '写页面' },
    { techIds: ['t1', 't2'], title: '接接口' },
  ]);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.state.cards.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(r.state.cards.map((c) => c.status), ['todo', 'todo']);
  assert.deepEqual(r.state.cards[1].techIds, ['t1', 't2']);
  assert.equal(r.state.cards[0].learn, null);
  assert.equal(r.state.cards[0].do, null);
  assert.equal(r.state.cards[0].evidence, null);
  assert.equal(r.state.cards[0].startedAt, null);
  assert.equal(r.state.cards[0].doneAt, null);
});

test('createCards：已有卡片时接号不撞 id；空 defs / 缺 title 被拒', () => {
  const base = stateWith([card('c3')]);
  const r = createCards(base, [{ techIds: ['t1'], title: '补一张' }]);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.state.cards.map((c) => c.id), ['c3', 'c4']);
  assert.equal(createCards(stateWith([]), []).ok, false);
  assert.equal(createCards(stateWith([]), [{ techIds: ['t1'], title: '  ' }]).ok, false);
  assert.equal(createCards(stateWith([]), [{ techIds: 't1', title: 'x' }]).ok, false);
});

test('startCard：todo → doing 且写 startedAt', () => {
  const base = stateWith([card('c1')]);
  const r = startCard(base, 'c1');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.cards[0].status, 'doing');
  assert.equal(typeof r.state.cards[0].startedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(r.state.cards[0].startedAt)));
});

test('startCard：stale → doing 允许；doing/done/downgraded 被拒', () => {
  assert.equal(startCard(stateWith([card('c1', 'stale')]), 'c1').ok, true);
  for (const status of ['doing', 'done', 'downgraded']) {
    const r = startCard(stateWith([card('c1', status)]), 'c1');
    assert.equal(r.ok, false, `${status} 不该允许开工`);
    assert.match(r.reason, /^plando：/);
    assert.match(r.reason, /——下一步：/);
  }
  assert.equal(startCard(stateWith([card('c1')]), 'c404').ok, false);
});

test('todo → doing → done 完整矩阵，evidence 与 doneAt 落位', () => {
  const s1 = doing();
  const r = doneCard(s1, 'c1', { kind: 'check', summary: 'node --test 全绿' });
  assert.equal(r.ok, true, r.reason);
  const c = r.state.cards[0];
  assert.equal(c.status, 'done');
  assert.equal(c.evidence.kind, 'check');
  assert.equal(c.evidence.summary, 'node --test 全绿');
  assert.equal(typeof c.evidence.at, 'string');
  assert.equal(typeof c.doneAt, 'string');
  const p = cardProgress(r.state);
  assert.equal(p.total, 1);
  assert.equal(p.done, 1);
  assert.equal(p.doing, 0);
});

test('doneCard：无证据被拒（缺 summary / kind 不合法 / 不是对象）', () => {
  const s = doing();
  for (const evidence of [undefined, null, {}, { kind: 'check' }, { kind: 'check', summary: '   ' }, { kind: 'x', summary: 'y' }]) {
    const r = doneCard(s, 'c1', evidence);
    assert.equal(r.ok, false, `${JSON.stringify(evidence)} 不该通过`);
    assert.match(r.reason, /^plando：/);
  }
  // 拒绝时状态不变
  assert.equal(s.cards[0].status, 'doing');
});

test('doneCard：todo 不能直接 done；stale 不能直接 done', () => {
  const r1 = doneCard(stateWith([card('c1', 'todo')]), 'c1', { kind: 'files', summary: '改了 app.js' });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /——下一步：/);
  const r2 = doneCard(stateWith([card('c1', 'stale')]), 'c1', { kind: 'files', summary: '改了 app.js' });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /stale/);
});

// REVIEW-tools M4：`kind:'check'` 的 summary 只是自述——「跑了 npm test，退出码 0」这句话在
// 从没跑过的时候一样写得出来。所以调用方把 .plando/last-check.json 的凭据传进来时要对账。
test('doneCard：check 类证据要与真实执行记录对账（M4）', () => {
  const evidence = { kind: 'check', summary: 'node --test 全绿' };

  // 从没跑过 → 拒
  const none = doneCard(doing(), 'c1', evidence, { lastCheck: null });
  assert.equal(none.ok, false);
  assert.match(none.reason, /没有任何执行记录/);

  // 最近一次是**别的卡**的检查 → 拒（不能拿 c2 的绿灯给 c1 作证）
  const other = doneCard(doing(), 'c1', evidence, { lastCheck: { name: 'c2', ok: true, exitCode: 0 } });
  assert.equal(other.ok, false);
  assert.match(other.reason, /不是这张卡/);

  // 最近一次是这张卡但**没通过** → 拒
  const failed = doneCard(doing(), 'c1', evidence, { lastCheck: { name: 'c1', ok: false, exitCode: 1 } });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /没通过/);

  // 对得上 → 通过
  const matched = doneCard(doing(), 'c1', evidence, { lastCheck: { name: 'c1', ok: true, exitCode: 0 } });
  assert.equal(matched.ok, true, matched.reason);
  assert.equal(matched.state.cards[0].status, 'done');

  // files 类证据不要求检查记录（改文件本来就没有「退出码」）
  const files = doneCard(doing(), 'c1', { kind: 'files', summary: '改了 src/app.js' }, { lastCheck: null });
  assert.equal(files.ok, true, files.reason);

  // 没传 lastCheck 这个键 → 不强制（纯函数调用方不该被文件系统依赖绊住；
  // tools.js 每次都会传，所以插件运行时这条对账一定生效）
  const noOption = doneCard(doing(), 'c1', evidence);
  assert.equal(noOption.ok, true, '调用方没提供凭据时不做对账（由 tools.js 保证总会提供）');
});

test('downgradeCard：必须带理由；写 downgrades 留痕；已收尾不能再降', () => {
  const s = doing();
  assert.equal(downgradeCard(s, 'c1', '').ok, false);
  assert.equal(downgradeCard(s, 'c1', '   ').ok, false);
  const r = downgradeCard(s, 'c1', '时间不够，只跑通 demo');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.cards[0].status, 'downgraded');
  assert.equal(r.state.downgrades.length, 1);
  assert.equal(r.state.downgrades[0].cardId, 'c1');
  assert.equal(r.state.downgrades[0].from, 'doing', '留痕要记下降级前的状态');
  assert.equal(r.state.downgrades[0].reason, '时间不够，只跑通 demo');
  assert.equal(typeof r.state.downgrades[0].at, 'string');
  assert.equal(cardProgress(r.state).downgraded, 1);
  assert.equal(downgradeCard(r.state, 'c1', '再来一次').ok, false);
});

// REVIEW-tools §12 R3：理由也要能核对。`'x'` / `'我懂了'` 写进 downgrades 等于没写，
// 而注释 philosophy 上它和 evidence 是同一个病——所以复用同一套「可观察性」判断。
test('downgradeCard：空话理由被拒，写清交付到哪一步才收', () => {
  const s = doing();
  for (const why of ['x', '我懂了', '完成了', '没问题']) {
    const r = downgradeCard(s, 'c1', why);
    assert.equal(r.ok, false, `空话理由应被拒：${why}`);
    assert.match(r.reason, /不算理由|实际交付/);
  }
  // 说清「降到哪」的照常通过
  const ok = downgradeCard(s, 'c1', '只跑通 demo，保存功能没做');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.state.downgrades[0].reason, '只跑通 demo，保存功能没做');
  // 拒绝时原 state 不变
  assert.equal(s.cards[0].status, 'doing');
  assert.equal(s.downgrades, undefined);
});

test('setLearn / setDo：写 note 与 files，空值被拒', () => {
  const base = stateWith([card('c1', 'doing')]);
  const l = setLearn(base, 'c1', '学会了 fetch 的错误处理');
  assert.equal(l.ok, true, l.reason);
  assert.equal(l.state.cards[0].learn.note, '学会了 fetch 的错误处理');
  assert.equal(typeof l.state.cards[0].learn.at, 'string');
  assert.equal(setLearn(base, 'c1', '').ok, false);

  const d = setDo(base, 'c1', ['src/app.js', 'README.md']);
  assert.equal(d.ok, true, d.reason);
  assert.deepEqual(d.state.cards[0].do.files, ['src/app.js', 'README.md']);
  assert.equal(typeof d.state.cards[0].do.at, 'string');
  assert.equal(setDo(base, 'c1', 'src/app.js').ok, false);
});

test('cardProgress：各态计数与 current 指向', () => {
  const s = stateWith([
    card('c1', 'done'), card('c2', 'downgraded'), card('c3', 'doing'), card('c4', 'todo'), card('c5', 'stale'),
  ]);
  assert.deepEqual(cardProgress(s), { total: 5, done: 1, downgraded: 1, doing: 1, todo: 1, stale: 1, current: 'c3' });
  // 没有 doing 时 current 取第一张未收尾的卡
  const s2 = stateWith([card('c1', 'done'), card('c2', 'todo')]);
  assert.equal(cardProgress(s2).current, 'c2');
  // 全部收尾 → current 为 null
  assert.equal(cardProgress(stateWith([card('c1', 'done'), card('c2', 'downgraded')])).current, null);
  assert.deepEqual(cardProgress({}), { total: 0, done: 0, downgraded: 0, doing: 0, todo: 0, stale: 0, current: null });
});

test('纯函数：传入 state 逐字节不变', () => {
  const base = stateWith([card('c1')]);
  const before = JSON.stringify(base);
  const snapshot = structuredClone(base);
  const created = createCards(base, [{ techIds: ['t1'], title: '新卡' }]);
  assert.equal(created.ok, true, created.reason);
  startCard(base, 'c1');
  setLearn(base, 'c1', '笔记');
  setDo(base, 'c1', ['a.js']);
  downgradeCard(base, 'c1', '不做了');
  cardProgress(base);
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(base, snapshot);
  // 返回值与入参不共享引用
  const started = startCard(base, 'c1');
  assert.notEqual(started.state.cards, base.cards);
  assert.equal(base.cards[0].status, 'todo');
});
