// test/policy.test.js —— lib/policy.js：能力分类 + 守卫语义表逐行 + 拒绝理由形状。
// 纯函数测试，不写盘、不碰真实项目；状态用最小手工对象。

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTool, DENY_CAPS, createGuard, denyReasonFor } from '../lib/policy.js';

// 一段正常的、有状态的上下文（tools.js 的 getStateContext 就是这个形状）。
function ctx(over = {}) {
  return {
    stage: 'build',
    label: '边做边学',
    nextAction: '用 plando_card 逐张推进，全部收尾后传 cards_done',
    paused: false,
    ...over,
  };
}

// 造守卫：默认有状态、无 extraDeny。
function guardOf(stateCtx = ctx(), config = { guardExtraDeny: [] }) {
  return createGuard({
    getStateContext: () => stateCtx,
    getConfig: () => config,
  });
}

// 拒绝理由的公共形状断言：前缀、下一步、长度、无 emoji。
function assertReasonShape(reason, label = '') {
  assert.equal(typeof reason, 'string', `${label} 拒绝理由必须是字符串`);
  assert.match(reason, /^plando：/, `${label} 必须以 plando： 开头，实际：${reason}`);
  assert.match(reason, /——下一步：/, `${label} 必须带「——下一步：」`);
  assert.ok([...reason].length <= 160, `${label} 长度必须 ≤160，实际 ${[...reason].length}`);
  // 无 emoji：拒绝一切星形符号 / 表情区码点。
  assert.doesNotMatch(reason, /\p{Extended_Pictographic}/u, `${label} 不能含 emoji`);
}

// ---------------------------------------------------------------------------
// 能力分类：每个能力至少 3 个样例，含带后缀变体
// ---------------------------------------------------------------------------

test('DENY_CAPS 逐字等于文档里的四项', () => {
  assert.deepEqual(DENY_CAPS, ['fs-write', 'shell', 'dynamic-code', 'subagent']);
});

const CAP_CASES = {
  'fs-write': ['write', 'write_file', 'edit', 'edit_file', 'str_replace_editor', 'apply_patch', 'apply_patch_pro'],
  shell: ['bash', 'bash_run', 'pwsh', 'pwsh_exec', 'terminal', 'shell_command', 'shell_exec'],
  'dynamic-code': ['run_code', 'code_interpreter', 'notebook', 'notebook_run', 'eval', 'eval_js'],
  subagent: ['subagent', 'subagent_fork', 'workflow', 'task', 'task_run'],
  read: ['read', 'read_file', 'glob', 'glob_search', 'grep', 'grep_file', 'list', 'list_dir', 'search', 'web_fetch', 'web_search'],
  plando: ['plando_status', 'plando_project', 'plando_transition', 'plando_card', 'plando_brand_new_tool'],
  unknown: ['present', 'todo_write', 'ask_user_question', 'schedule_create', 'mystery'],
};

for (const [cap, names] of Object.entries(CAP_CASES)) {
  test(`classifyTool：${cap} 的样例全部归到该能力`, () => {
    for (const name of names) assert.equal(classifyTool(name), cap, `${name} 应归为 ${cap}`);
  });
}

test('classifyTool：脏输入一律 unknown，不抛错', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}, [], true]) {
    assert.equal(classifyTool(bad), 'unknown', `${JSON.stringify(bad)} 应为 unknown`);
  }
});

test('classifyTool：大小写与前缀匹配（Write / BASH_RUN 也算写与命令）', () => {
  assert.equal(classifyTool('Write'), 'fs-write');
  assert.equal(classifyTool('BASH_RUN'), 'shell');
  assert.equal(classifyTool('Read_File'), 'read');
});

test('classifyTool：plando_ 前缀优先于 read/unknown 判定', () => {
  // plando_list_projects 以 list 之外的前缀开头，但即便撞上 read 前缀也必须先归 plando。
  assert.equal(classifyTool('plando_list'), 'plando');
  assert.equal(classifyTool('plando_read_state'), 'plando');
});

// ---------------------------------------------------------------------------
// 守卫语义表：INTERFACES §2 的 6 行 + fail-closed，逐行一条
// ---------------------------------------------------------------------------

test('语义表第 1 行：plando_ 开头放行（有状态 / 无状态都放行）', () => {
  assert.equal(guardOf()({ name: 'plando_status' }), undefined);
  assert.equal(guardOf(ctx())({ name: 'plando_transition' }), undefined);
  // 状态读不出来时仍然放行：自带阶段校验，不靠守卫。
  assert.equal(guardOf(null)({ name: 'plando_project' }), undefined);
});

test('语义表第 2 行：read / unknown 放行（状态读不出来也放行）', () => {
  for (const name of ['read', 'read_file', 'glob', 'grep', 'list_dir', 'search', 'web_fetch']) {
    assert.equal(guardOf()({ name }), undefined, `${name} 应放行`);
    assert.equal(guardOf(null)({ name }), undefined, `${name} 无状态也应放行`);
  }
  for (const name of ['present', 'todo_write', 'mystery_tool']) {
    assert.equal(guardOf()({ name }), undefined, `${name}（unknown）应放行`);
    assert.equal(guardOf(null)({ name }), undefined, `${name}（unknown）无状态也应放行`);
  }
});

test('语义表第 3 行：subagent / dynamic-code 永远拒绝，无论状态读不读得到', () => {
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'task', 'run_code', 'code_interpreter', 'notebook_run', 'eval']) {
    const withState = guardOf()({ name });
    const noState = guardOf(null)({ name });
    assert.equal(typeof withState, 'string', `${name} 有状态时必须拒绝`);
    assert.equal(typeof noState, 'string', `${name} 无状态时必须拒绝`);
    assertReasonShape(withState, `${name}（有状态）`);
    assertReasonShape(noState, `${name}（无状态）`);
    // 结构性限制：理由要说清楚换阶段也不放开。
    assert.match(withState, /结构性限制/);
  }
});

test('语义表第 4 行：fs-write / shell 状态读不出来时 fail-closed', () => {
  for (const name of ['write', 'edit', 'apply_patch', 'bash', 'pwsh', 'terminal', 'shell_exec']) {
    const reason = guardOf(null)({ name });
    assert.equal(typeof reason, 'string', `${name} 无状态时必须拒绝（fail-closed）`);
    assertReasonShape(reason, `${name}`);
    assert.match(reason, /fail-closed/, `${name} 理由要说明 fail-closed`);
  }
  // getStateContext 抛错也按读不出来处理。
  const throwing = createGuard({
    getStateContext: () => {
      throw new Error('读盘失败');
    },
    getConfig: () => ({ guardExtraDeny: [] }),
  });
  assert.equal(typeof throwing({ name: 'write' }), 'string', '状态抛错时写类必须拒绝');
  assert.equal(throwing({ name: 'read' }), undefined, '状态抛错时读类仍放行');
});

test('语义表第 5 行：fs-write / shell 有状态时拒绝，理由带阶段名与下一步', () => {
  for (const name of ['write', 'edit', 'bash', 'pwsh']) {
    const reason = guardOf()({ name });
    assert.equal(typeof reason, 'string', `${name} 有状态时必须拒绝`);
    assertReasonShape(reason, name);
    assert.match(reason, /边做边学/, `${name} 理由要带阶段名`);
    assert.match(reason, /plando_card/, `${name} 理由要带下一步动作`);
  }
});

test('语义表第 6 行：guardExtraDeny 点名永远拒绝（含只读与 plando 名字）', () => {
  const cfg = { guardExtraDeny: ['present', ' custom_tool '] };
  const g = createGuard({ getStateContext: () => ctx(), getConfig: () => cfg });
  for (const name of ['present', 'custom_tool', 'present']) {
    const reason = g({ name });
    assert.equal(typeof reason, 'string', `${name} 被点名时必须拒绝`);
    assertReasonShape(reason, name);
    assert.match(reason, /guardExtraDeny/);
  }
  // 大小写不敏感
  assert.equal(typeof g({ name: 'PRESENT' }), 'string');
  // 没点名的仍按普通规则走
  assert.equal(g({ name: 'read' }), undefined);
  // 点名的优先级高于「读放行」：即使状态读不出来也拒绝
  const g2 = createGuard({ getStateContext: () => null, getConfig: () => cfg });
  assert.equal(typeof g2({ name: 'present' }), 'string');
});

test('守卫：exec 缺 name / 非对象时不炸（按 unknown 放行）', () => {
  const g = guardOf();
  assert.equal(g(undefined), undefined);
  assert.equal(g(null), undefined);
  assert.equal(g({}), undefined);
  assert.equal(g('write'), undefined);
});

test('守卫：deps 缺函数时不炸，写类照 fail-closed', () => {
  const g = createGuard();
  assert.equal(typeof g({ name: 'write' }), 'string');
  assert.equal(g({ name: 'read' }), undefined);
});

test('守卫：暂停状态把 resume 写进拒绝理由', () => {
  const reason = guardOf(ctx({ paused: true }))({ name: 'write' });
  assert.equal(typeof reason, 'string');
  assertReasonShape(reason, 'paused');
  assert.match(reason, /resume/);
});

test('守卫：单调性——同一守卫连续调用结果稳定，且不修改 deps 返回的对象', () => {
  const state = ctx();
  const snapshot = JSON.stringify(state);
  const g = createGuard({ getStateContext: () => state, getConfig: () => ({ guardExtraDeny: [] }) });
  const first = g({ name: 'write' });
  const second = g({ name: 'write' });
  assert.equal(first, second);
  assert.equal(JSON.stringify(state), snapshot, '守卫不得修改状态对象');
});

// ---------------------------------------------------------------------------
// denyReasonFor：reason 形状的单元级断言
// ---------------------------------------------------------------------------

test('denyReasonFor：写类 / 命令类理由带阶段与下一步，符合 CONTRACT §5', () => {
  for (const name of ['write', 'edit', 'str_replace_editor', 'apply_patch', 'bash', 'pwsh', 'terminal', 'shell']) {
    const reason = denyReasonFor(name, ctx());
    assertReasonShape(reason, name);
    assert.match(reason, /边做边学/);
    assert.match(reason, /——下一步：/);
  }
});

test('denyReasonFor：subagent / dynamic-code 理由说明结构性限制', () => {
  for (const name of ['subagent', 'workflow', 'task', 'run_code', 'notebook', 'eval']) {
    const reason = denyReasonFor(name, ctx());
    assertReasonShape(reason, name);
    assert.match(reason, /结构性限制/);
    assert.match(reason, /不挂/);
  }
});

test('denyReasonFor：长阶段名与长 nextAction 仍截断到 ≤160 字且保住下一步', () => {
  const long = ctx({ label: '很长的阶段名'.repeat(20), nextAction: '下一步要做的事情'.repeat(20) });
  const reason = denyReasonFor('write', long);
  assert.ok([...reason].length <= 160, `实际 ${[...reason].length}`);
  assert.match(reason, /^plando：/);
  assert.match(reason, /——下一步：/);
});

test('denyReasonFor：ctx 为 null / 脏值时走 fail-closed 文案且不抛', () => {
  for (const bad of [null, undefined, '', 0, [], { stage: 123 }]) {
    const reason = denyReasonFor('write', bad);
    assertReasonShape(reason, String(bad));
  }
});

test('denyReasonFor：未知能力名给出兜底理由，形状不变', () => {
  const reason = denyReasonFor('present', ctx());
  assertReasonShape(reason, 'present');
});
