// test/format.test.js —— lib/format.js：7 个渲染函数的形状、行数上限、纯函数与抗脏数据。
// 全部是纯文本断言，不写盘、不看时钟。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatStatus, formatProjectList, formatIdeaList, formatCard,
  formatTransition, formatCheck, formatRecover, nextActionFor,
} from '../lib/format.js';

const lineCount = (s) => s.split('\n').length;

// 形状公共断言：必须是非空字符串、无 emoji。
function assertPlainText(out, label) {
  assert.equal(typeof out, 'string', `${label} 必须返回字符串`);
  assert.ok(out.trim().length > 0, `${label} 不能返回空串`);
  assert.doesNotMatch(out, /\p{Extended_Pictographic}/u, `${label} 不能含 emoji`);
}

// 一份「正常」状态：build 阶段、有卡、有产物、有预算。
function sampleState() {
  return {
    schemaVersion: 1,
    projectId: 'proj_abcd1234',
    name: '记账小工具',
    dir: 'C:\\tmp\\jizhang',
    stage: 'build',
    paused: false,
    updatedAt: '2026-01-02T03:04:05.000Z',
    budget: { mustUnderstand: 5, totalMinutes: 600 },
    idea: { title: '记账小工具', oneLine: '一句话记账' },
    tech: {
      items: [
        { id: 't1', title: '读文件', owner: 'user', minutes: 60, judge: '能读出 JSON' },
        { id: 't2', title: '写页面', owner: 'ai', minutes: 120, judge: '能打开' },
      ],
      size: 'small',
    },
    cards: [
      { id: 'c1', techIds: ['t1'], title: '读文件', status: 'done', learn: { note: '会读 JSON 了', at: 'x' }, do: { files: ['a.js'], at: 'x' }, verify: { output: '', exitCode: 0, at: 'x' }, evidence: { kind: 'check', summary: '退出码 0', at: 'x' }, startedAt: 'x', doneAt: 'x' },
      { id: 'c2', techIds: ['t2'], title: '写页面', status: 'doing', learn: null, do: null, verify: null, evidence: null, startedAt: 'x', doneAt: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

test('formatStatus：正常数据含阶段 / 下一步 / 卡进度 / 产物 / 预算，且 ≤40 行', () => {
  const out = formatStatus({
    state: sampleState(),
    projectDir: 'C:\\tmp\\jizhang',
    progress: { total: 2, done: 1, downgraded: 0, doing: 1, todo: 0, stale: 0, current: 'c2' },
    pending: ['要不要支持多账本？'],
    artifacts: ['IDEA.md', 'TECH.md'],
    budget: { mustUnderstand: 5, totalMinutes: 600 },
  });
  assertPlainText(out, 'formatStatus');
  assert.match(out, /记账小工具/);
  assert.match(out, /边做边学/);
  assert.match(out, /下一步/);
  assert.match(out, /共 2 张/);
  assert.match(out, /2 条未解问题|1 条/);
  assert.match(out, /IDEA\.md/);
  assert.match(out, /预算/);
  assert.ok(lineCount(out) <= 40, `行数 ${lineCount(out)} 超过 40`);
});

test('formatStatus：脏数据不炸（null / 空对象 / 各种畸形字段）', () => {
  for (const bad of [undefined, null, 42, 'oops', [], {}, { state: null }, { state: 'x', progress: 1, pending: 2, artifacts: 3 }]) {
    const out = formatStatus(bad);
    assertPlainText(out, `formatStatus(${JSON.stringify(bad)})`);
    assert.ok(lineCount(out) <= 40);
  }
});

test('formatStatus：暂停状态给出 resume 提醒', () => {
  const state = { ...sampleState(), paused: true };
  const out = formatStatus({ state });
  assert.match(out, /暂停/);
  assert.match(out, /resume/);
});

test('7 个函数都真的返回多行文本（行首是 ·，不是用逗号拼成一行）', () => {
  const state = sampleState();
  const outs = [
    formatStatus({ state, progress: { total: 2, done: 1, current: 'c2' }, pending: ['x'], artifacts: ['IDEA.md'] }),
    formatProjectList([{ name: 'a', ok: true, dir: 'C:\\a', stage: 'build', updatedAt: 'x' }]),
    formatIdeaList([{ id: 'i1', title: 't', at: 'x' }]),
    formatCard(state, state.cards[1]),
    formatTransition(true, { event: 'idea_ok', from: 'idea', to: 'tech' }),
    formatRecover('坏了', 'C:\\p'),
  ];
  for (const out of outs) {
    assert.ok(lineCount(out) >= 2, `应至少两行，实际：${out}`);
    assert.ok(out.split('\n')[0].startsWith('· '), `行首应为「· 」，实际：${out.split('\n')[0]}`);
    assert.doesNotMatch(out, /^·[^\n]*·[^\n]*/, '不能把多行压成一行用 · 分隔');
  }
  // formatCheck 的 stdout 原样保留换行，不能被压成一行。
  const check = formatCheck({ ok: true, name: 'n', exitCode: 0, stdout: 'a\nb', stderr: '' });
  assert.ok(check.includes('  a\n  b'), `stdout 换行丢失：${check}`);
});

// ---------------------------------------------------------------------------
// formatProjectList
// ---------------------------------------------------------------------------

test('formatProjectList：正常列表逐项显示名称 / 阶段 / 更新时间；失败项带理由', () => {
  const out = formatProjectList([
    { name: '记账', dir: 'C:\\tmp\\a', stage: 'build', updatedAt: '2026-01-01T00:00:00.000Z', ok: true },
    { name: '坏项目', dir: 'C:\\tmp\\b', ok: false, reason: 'plando：state.json 解析失败' },
  ]);
  assertPlainText(out, 'formatProjectList');
  assert.match(out, /记账/);
  assert.match(out, /边做边学/);
  assert.match(out, /坏项目/);
  assert.match(out, /读不出来/);
  assert.ok(lineCount(out) <= 15, `行数 ${lineCount(out)} 超过 15`);
});

test('formatProjectList：空 / 畸形输入给出「还没有项目」而不是抛错', () => {
  for (const bad of [undefined, null, [], [null, 1, 'x'], 'oops', {}]) {
    const out = formatProjectList(bad);
    assertPlainText(out, `formatProjectList(${JSON.stringify(bad)})`);
    assert.ok(lineCount(out) <= 15);
  }
  assert.match(formatProjectList([]), /还没有项目/);
});

// ---------------------------------------------------------------------------
// formatIdeaList
// ---------------------------------------------------------------------------

test('formatIdeaList：正常列表带 id / 标题 / 时间与状态标记', () => {
  const out = formatIdeaList([
    { id: 'i1', title: '随手记账', at: '2026-01-01', picked: true },
    { id: 'i2', title: '背单词', at: '2026-01-02', parked: true },
  ]);
  assertPlainText(out, 'formatIdeaList');
  assert.match(out, /共 2 条/);
  assert.match(out, /随手记账/);
  assert.match(out, /已立项/);
  assert.match(out, /背单词/);
  assert.match(out, /已搁置/);
  assert.ok(lineCount(out) <= 15);
});

test('formatIdeaList：空 / 畸形输入不炸', () => {
  for (const bad of [undefined, null, [], [null, {}, 3], 'x']) {
    const out = formatIdeaList(bad);
    assertPlainText(out, `formatIdeaList(${JSON.stringify(bad)})`);
    assert.ok(lineCount(out) <= 15);
  }
  assert.match(formatIdeaList([]), /灵感库是空的/);
});

// ---------------------------------------------------------------------------
// nextActionFor
// ---------------------------------------------------------------------------

test('nextActionFor：decide + large 未验证时推荐 verify，且理由读起来不像命令', () => {
  const out = nextActionFor('decide', { tech: { size: 'large' }, verify: { result: null } });
  assertPlainText(out, 'nextActionFor');
  assert.match(out, /choose_verify/, '要明确说下一步传哪个事件');
  // 语气要求（用户反馈「生硬」）：给理由和预期收益，而不是「不许开工」这种禁令。
  assert.match(out, /规模/, '要说明为什么建议先验证');
  assert.doesNotMatch(out, /不许|禁止/, '不要再写禁令式措辞');
  // 验证过之后就不再特判，回到普通「三选一」提示（那时三选一里本来也会提到 choose_verify）。
  const after = nextActionFor('decide', { tech: { size: 'large' }, verify: { result: 'pass' } });
  assert.doesNotMatch(after, /小验证/);
  // small 项目同样不该被特判。
  assert.doesNotMatch(nextActionFor('decide', { tech: { size: 'small' }, verify: { result: null } }), /小验证/);
  // 脏输入不炸。
  for (const bad of [undefined, null, {}, 'decide']) {
    assertPlainText(nextActionFor(bad, undefined), 'nextActionFor 畸形');
    assertPlainText(nextActionFor(bad, 'x'), 'nextActionFor 畸形 state');
  }
});

// ---------------------------------------------------------------------------
// formatCard
// ---------------------------------------------------------------------------

test('formatCard：进行中的卡列出学 / 做 / 验三段现状与缺什么', () => {
  const state = sampleState();
  const card = state.cards[1];
  const out = formatCard(state, card);
  assertPlainText(out, 'formatCard');
  assert.match(out, /c2/);
  assert.match(out, /学：/);
  assert.match(out, /做：/);
  assert.match(out, /验：/);
  assert.match(out, /缺什么/);
  assert.match(out, /证据/);
  assert.ok(lineCount(out) <= 15, `行数 ${lineCount(out)} 超过 15`);
});

test('formatCard：已收尾的卡不再要求补证据；缺 state / card 也不炸', () => {
  const state = sampleState();
  const done = formatCard(state, state.cards[0]);
  assert.match(done, /可以收尾|无/);
  for (const [s, c] of [[undefined, undefined], [null, null], [{}, { id: 1 }], ['x', 'y']]) {
    const out = formatCard(s, c);
    assertPlainText(out, 'formatCard 畸形');
    assert.ok(lineCount(out) <= 15);
  }
});

// ---------------------------------------------------------------------------
// formatTransition
// ---------------------------------------------------------------------------

test('formatTransition：成功时显示 from → to 与 effects', () => {
  const out = formatTransition(true, {
    event: 'tech_ok',
    from: 'tech',
    to: 'decide',
    effects: { rerender: ['TECH.md'], invalidateCards: ['c1'], note: '清单已锁定' },
  });
  assertPlainText(out, 'formatTransition');
  assert.match(out, /技术拆解/);
  assert.match(out, /选路/);
  assert.match(out, /→/);
  assert.match(out, /TECH\.md/);
  assert.match(out, /c1/);
  assert.ok(lineCount(out) <= 15);
});

test('formatTransition：失败时给理由且不显示「已推进」；畸形输入不炸', () => {
  const bad = formatTransition(false, { event: 'ship_pass', from: 'ship', reason: 'plando：还没跑验收' });
  assertPlainText(bad, 'formatTransition 失败');
  assert.doesNotMatch(bad, /已推进/);
  assert.match(bad, /还没跑验收/);
  for (const [ok, d] of [[true, undefined], [true, null], [false, 'x'], [undefined, {}], [true, { to: 'nope' }]]) {
    const out = formatTransition(ok, d);
    assertPlainText(out, 'formatTransition 畸形');
    assert.ok(lineCount(out) <= 15);
  }
});

test('formatTransition：pause / resume 的 to 为 null 时把阶段名保持一致', () => {
  const out = formatTransition(true, { event: 'pause', from: 'build', to: null });
  assert.match(out, /边做边学 → 边做边学/);
});

// ---------------------------------------------------------------------------
// formatCheck
// ---------------------------------------------------------------------------

test('formatCheck：通过时显示退出码与输出', () => {
  const out = formatCheck({ ok: true, name: 'unit', exitCode: 0, stdout: 'ok\n2 passed', stderr: '' });
  assertPlainText(out, 'formatCheck');
  assert.match(out, /unit/);
  assert.match(out, /通过/);
  assert.match(out, /退出码 0/);
  assert.match(out, /2 passed/);
  assert.ok(lineCount(out) <= 15);
});

test('formatCheck：失败时显示理由 / stderr / 下一步；畸形输入不炸', () => {
  const out = formatCheck({ ok: false, name: 'unit', exitCode: 1, stdout: '', stderr: 'boom', reason: '断言失败' });
  assertPlainText(out, 'formatCheck 失败');
  assert.match(out, /未通过/);
  assert.match(out, /断言失败/);
  assert.match(out, /boom/);
  assert.match(out, /下一步/);
  for (const bad of [undefined, null, {}, 'x', { exitCode: 'zero' }]) {
    const o = formatCheck(bad);
    assertPlainText(o, 'formatCheck 畸形');
    assert.ok(lineCount(o) <= 15);
  }
});

test('formatCheck：超长 stdout 会被压到行数上限内', () => {
  const stdout = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const out = formatCheck({ ok: false, name: 'long', exitCode: 1, stdout, stderr: '' });
  assert.ok(lineCount(out) <= 15, `行数 ${lineCount(out)} 超过 15`);
  assert.match(out, /省略/);
});

// ---------------------------------------------------------------------------
// formatRecover
// ---------------------------------------------------------------------------

test('formatRecover：必须明确「不要重置」，并给出打开项目的下一步', () => {
  const out = formatRecover('plando：state.json 解析失败', 'C:\\tmp\\p');
  assertPlainText(out, 'formatRecover');
  assert.match(out, /不要重置/);
  assert.match(out, /state\.json/);
  assert.match(out, /备份/);
  assert.match(out, /plando_project/);
  assert.match(out, /C:\\tmp\\p/);
  assert.ok(lineCount(out) <= 15);
});

test('formatRecover：畸形输入不炸，仍保留「不要重置」', () => {
  for (const [r, d] of [[undefined, undefined], [null, null], [42, 0], [{}, []], ['', '']]) {
    const out = formatRecover(r, d);
    assertPlainText(out, 'formatRecover 畸形');
    assert.match(out, /不要重置/);
    assert.ok(lineCount(out) <= 15);
  }
});

// ---------------------------------------------------------------------------
// 纯函数：同一输入两次结果相同、不修改入参
// ---------------------------------------------------------------------------

test('7 个函数都是纯函数：同输入两次输出逐字相同，且不改入参', () => {
  const state = sampleState();
  const snapshot = JSON.stringify(state);
  const argsList = [
    [formatStatus, [{ state, projectDir: 'C:\\tmp\\p', progress: { total: 2, done: 1, current: 'c2' }, pending: ['x'], artifacts: ['IDEA.md'] }]],
    [formatProjectList, [[{ name: 'a', dir: 'C:\\a', stage: 'build', updatedAt: 'x', ok: true }]]],
    [formatIdeaList, [[{ id: 'i1', title: 't', at: 'x' }]]],
    [formatCard, [state, state.cards[0]]],
    [formatTransition, [true, { event: 'idea_ok', from: 'idea', to: 'tech', effects: { rerender: ['IDEA.md'] } }]],
    [formatCheck, [{ ok: true, name: 'n', exitCode: 0, stdout: 'ok', stderr: '' }]],
    [formatRecover, ['坏了', 'C:\\p']],
  ];
  for (const [fn, args] of argsList) {
    const a = fn(...args);
    const b = fn(...args);
    assert.equal(a, b, `${fn.name} 不是纯函数（两次输出不同）`);
  }
  assert.equal(JSON.stringify(state), snapshot, '渲染不得修改 state');
});

test('7 个函数都不看时钟：同输入在不同时刻仍相同（不出现「今天/现在」等相对时间）', () => {
  const out = formatStatus({ state: sampleState() });
  assert.doesNotMatch(out, /刚刚|今天|现在 \d|秒前|分钟前/);
  const recover = formatRecover('坏了', 'C:\\p');
  assert.doesNotMatch(recover, /\d{4}-\d{2}-\d{2}T/);
});
