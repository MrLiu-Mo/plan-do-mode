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

// REVIEW-tools §14 R7：M4 只对账了 check 分支，files 分支零文件系统访问——
// 于是 `summary:'创建了完全不存在-abc123.py'` 照样能过，
// 「1 张 done + 全降级」就成了一条零产出到 done 的短路。
test('doneCard：files 类证据要点名项目里真实存在的文件（§14 R7）', () => {
  const files = ['index.html', 'src/app.js'];

  // 声称的文件不存在 → 拒
  const phantom = doneCard(doing(), 'c1', { kind: 'files', summary: '创建了完全不存在-abc123.py' }, { projectFiles: files });
  assert.equal(phantom.ok, false, '不存在的文件不能当证据');
  assert.match(phantom.reason, /找不到/);

  // 证据里没点任何文件名 → 拒
  const noName = doneCard(doing(), 'c1', { kind: 'files', summary: '功能都跑起来了' }, { projectFiles: files });
  assert.equal(noName.ok, false);
  assert.match(noName.reason, /找不到/);

  // 点到了真实文件 → 通过（完整路径、纯文件名、子目录三种写法都认）
  for (const summary of ['index.html 能录入并保存', '改了 src/app.js', 'app.js 里加了保存逻辑']) {
    const ok = doneCard(doing(), 'c1', { kind: 'files', summary }, { projectFiles: files });
    assert.equal(ok.ok, true, `${summary} 应通过：${ok.reason}`);
  }

  // do.files 里写过的文件也算「点名」（模型常把文件名放 do、summary 只写结论）
  const state = doing();
  state.cards[0].do = { files: ['index.html'], at: '2026-01-01T00:00:00.000Z' };
  const viaDo = doneCard(state, 'c1', { kind: 'files', summary: '页面能用了' }, { projectFiles: files });
  assert.equal(viaDo.ok, true, `do.files 点了名也应通过：${viaDo.reason}`);

  // check 类证据不受这条约束（它有自己的对账）
  const checkOk = doneCard(doing(), 'c1', { kind: 'check', summary: 'node --test 全绿' }, { lastCheck: { name: 'c1', ok: true, exitCode: 0 }, projectFiles: [] });
  assert.equal(checkOk.ok, true, checkOk.reason);

  // 调用方不传 projectFiles 时不强制（纯函数约定）
  const noFiles = doneCard(doing(), 'c1', { kind: 'files', summary: '创建了不存在-abc123.py' });
  assert.equal(noFiles.ok, true, '没传 projectFiles 时不做文件对账');
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

// REVIEW-tools §12 R3 / §14 R7：理由也要能核对。`'x'` / `'我懂了'` 写进 downgrades 等于没写，
// 而 `'时间不够'` 这种「听着像理由但没有具体对象」的也要拦——它说不出降级后交付了什么。
// §14 实测旧版判别力≈「≥4 字」：36 条空话放过 28 条。这条测试把那 36 条钉住。
test('downgradeCard：空话理由被拒，写清交付到哪一步才收', () => {
  const s = doing();
  // 显式空话
  for (const why of ['x', '我懂了', '完成了', '没问题', 'ok', '好了', '基本完成', '差不多了']) {
    const r = downgradeCard(s, 'c1', why);
    assert.equal(r.ok, false, `空话理由应被拒：${why}`);
    assert.match(r.reason, /不算理由|实际交付/);
  }
  // §14 列出的 36 条「听着像理由但没对象」——旧版放过 28 条，新版必须全拒
  const pseudo = [
    '时间不够', '没时间了', '不想做了', '做不下去了', '太难了', '太复杂了',
    '搞不定', '做不出来', '卡住了', '有困难', '能力不行', '水平不够',
    '先放着', '以后再说', '下次补', '暂时跳过', '先略过', '不做了',
    '差不多就行', '够用了', '可以先这样', '勉强能用', '凑合着', '这样也行',
    '没有空', '忙不过来', '精力有限', '状态不好', '心情不好', '想休息',
    '反正也不重要', '无所谓', '随便吧', '算了吧', '就这样', '别的更要紧',
    // 逗号不能当「分成了两段」的凭据（试过，8/8 漏放）
    '随便吧，不做了', '算了，跳过', '太难了，放弃', '以后再说，下次补',
  ];
  for (const why of pseudo) {
    const r = downgradeCard(s, 'c1', why);
    assert.equal(r.ok, false, `没对象的理由应被拒：${why}`);
  }
  // 说清「降到哪」的照常通过（误杀检查：12 条真实理由只能放过 11 条，
  // 唯一例外是光秃秃的「时间不够」——它确实没交代交付了什么，是故意拒的）
  for (const why of [
    '时间不够，改成只跑通 demo',
    '没时间，只做出静态页面',
    '卡在环境配置上，先做出静态页面',
    'API 拿不到 key，改成用本地假数据',
    '范围太大，这版只做录入不做搜索',
    '不会写测试，跳过自动化检查',
    '先把界面搭出来，逻辑下次再说',
    '实现了一半，列表能显示但不能编辑',
    '只跑通 demo，保存功能没做',
    '第 2 步做完了，第 3 步没开始',
    '导出功能砍掉，只保留录入',
  ]) {
    const r = downgradeCard(s, 'c1', why);
    assert.equal(r.ok, true, `真实理由不该误杀：${why} → ${r.reason}`);
  }
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
