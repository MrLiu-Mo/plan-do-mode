// test/tools.test.js —— lib/tools.js：8 个工具的形状、注册顺序、execute 永不抛。
//
// 断言重点（task-8）：
//   1. registered 恰好 8 个，名字与 TOOL_NAMES 完全一致（含顺序）。
//   2. 每个 definition 是纯对象，有 name/description/parameters/output.schema/output.render/execute。
//   3. output.render 返回 [{ type:'text', text }]。
//   4. 每个 execute 在明显错误的参数下返回字符串，而不是抛异常。
//   5. plando_status 在没有项目时返回可读中文，而不是崩。
// 全部在 fs.mkdtempSync(os.tmpdir()) 里跑（API-FACTS §5：绝不写真实目录）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOL_NAMES, registerTools } from '../lib/tools.js';
import * as state from '../lib/state.js';
import * as project from '../lib/project.js';
import * as artifacts from '../lib/artifacts.js';
import * as cards from '../lib/cards.js';
import * as checks from '../lib/checks.js';
import * as scaffold from '../lib/scaffold.js';
import * as git from '../lib/git.js';
import * as policy from '../lib/policy.js';
import * as format from '../lib/format.js';

// 每个用例一棵临时目录，config 全指到临时目录下（不碰 ~/.plando）。
function makeDeps(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    dataRoot: path.join(root, 'data'),
    budget: { mustUnderstand: 5, totalMinutes: 600 },
    defaultProjectDir: path.join(root, 'proj'),
    autoCommit: false,
    guardExtraDeny: [],
    ...(overrides.config || {}),
  };
  const deps = {
    config,
    paths: project.projectPaths(config.defaultProjectDir),
    // 生产环境里由 lib/index.js 注入；测试也带上，才能验证「活跃项目」相关的行为。
    runtime: { activeProjectDir: '' },
    state,
    project,
    artifacts,
    cards,
    checks,
    scaffold,
    git,
    policy,
    format,
    ...overrides.deps,
  };
  return { deps, root, config };
}

// 按 API-FACTS §5 的假 ctx 注册，拿回 definition 列表。
function registerAll(t, overrides) {
  const made = makeDeps(t, overrides);
  const registered = [];
  const ctx = { tools: { register: (def) => registered.push(def), guard: () => {} } };
  const names = registerTools(ctx, made.deps);
  return { ...made, registered, names };
}

test('TOOL_NAMES 恰好 8 个，顺序照 PLAN §4', () => {
  assert.deepEqual(TOOL_NAMES, [
    'plando_status',
    'plando_project',
    'plando_idea',
    'plando_clarify',
    'plando_transition',
    'plando_card',
    'plando_check',
    'plando_scaffold',
  ]);
});

test('registerTools 注册 8 个工具，名字与 TOOL_NAMES 一致且顺序相同', (t) => {
  const { registered, names } = registerAll(t);
  assert.equal(registered.length, 8);
  assert.deepEqual(names, TOOL_NAMES);
  assert.deepEqual(registered.map((def) => def.name), TOOL_NAMES);
  assert.equal(new Set(names).size, 8);
});

test('每个 definition 都有 name/description/parameters/output.schema/output.render/execute', (t) => {
  const { registered } = registerAll(t);
  for (const def of registered) {
    assert.equal(typeof def.name, 'string');
    assert.ok(def.name.startsWith('plando_'), `${def.name} 必须带 plando_ 前缀`);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 10, `${def.name} 的 description 要写给模型看`);
    assert.equal(typeof def.parameters, 'object');
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.parameters.properties, 'object');
    assert.equal(typeof def.output, 'object');
    assert.deepEqual(def.output.schema, { type: 'string' });
    assert.equal(typeof def.output.render, 'function');
    assert.equal(typeof def.execute, 'function');
    // definition 必须是纯对象（不是 defineTool 的产物）
    assert.equal(Object.getPrototypeOf(def), Object.prototype);
  }
});

test('output.render 把字符串包成 [{ type: "text", text }]', (t) => {
  const { registered } = registerAll(t);
  for (const def of registered) {
    assert.deepEqual(def.output.render({}, '一段文本'), [{ type: 'text', text: '一段文本' }]);
    assert.deepEqual(def.output.render(undefined, 42), [{ type: 'text', text: '42' }]);
  }
});

test('每个 execute 在明显错误的参数下返回字符串而不是抛', async (t) => {
  const { registered } = registerAll(t);
  const badArgs = ['不是对象', 42, null, undefined, {}, { action: '不存在的动作' }];
  for (const def of registered) {
    for (const args of badArgs) {
      const out = await def.execute(args);
      assert.equal(typeof out, 'string', `${def.name} 在参数 ${JSON.stringify(args)} 下必须返回字符串`);
      assert.ok(out.length > 0);
    }
  }
});

test('execute 返回的错误文本是 plando 形状（plando：… 或可读中文）', async (t) => {
  const { registered } = registerAll(t);
  const dir = registered.find((d) => d.name === 'plando_transition');
  const out = await dir.execute({ event: 'pick', dir: path.join(os.tmpdir(), 'plando-不存在-项目') });
  assert.equal(typeof out, 'string');
  // pick 必须被拒，并指向 plando_idea action=pick（CONTRACT §2.1）
  assert.match(out, /plando_idea action=pick/);
});

test('plando_status 在没有项目时返回可读中文，而不是崩', async (t) => {
  const { registered, config } = registerAll(t);
  const status = registered.find((d) => d.name === 'plando_status');
  const out = await status.execute({ dir: config.defaultProjectDir });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 20, '恢复指引不能只有一句话');
  assert.match(out, /[\u4e00-\u9fa5]/, '必须是中文，不是英文堆栈');
  assert.match(out, /不要重置|读不出|恢复/);
});

test('plando_project action=init 后 plando_status 能读到阶段', async (t) => {
  const { registered, config } = registerAll(t);
  const init = registered.find((d) => d.name === 'plando_project');
  const status = registered.find((d) => d.name === 'plando_status');
  const dir = path.join(config.defaultProjectDir, 'demo');
  const created = await init.execute({ action: 'init', dir, name: '演示' });
  assert.equal(typeof created, 'string');
  assert.match(created, /澄清|立项|已/);
  assert.ok(fs.existsSync(path.join(dir, '.plando', 'state.json')));

  const out = await status.execute({ dir });
  assert.equal(typeof out, 'string');
  assert.match(out, /clarify|澄清/);
});

test('plando_idea action=add / list 走通且列表可读', async (t) => {
  const { registered, config } = registerAll(t);
  const idea = registered.find((d) => d.name === 'plando_idea');
  const added = await idea.execute({ action: 'add', title: '一个想法' });
  assert.match(added, /idea_/);
  assert.ok(fs.existsSync(path.join(config.dataRoot, 'ideas.json')));
  const listed = await idea.execute({ action: 'list' });
  assert.match(listed, /一个想法/);
});

test('plando_scaffold 拒绝 owner !== "ai" 与白名单外的路径', async (t) => {
  const { registered, config } = registerAll(t);
  const init = registered.find((d) => d.name === 'plando_project');
  const scaffoldDef = registered.find((d) => d.name === 'plando_scaffold');
  const dir = path.join(config.defaultProjectDir, 'scaffold-demo');
  await init.execute({ action: 'init', dir, name: '脚手架演示' });

  const noProject = await scaffoldDef.execute({ dir: path.join(config.defaultProjectDir, 'nope'), path: 'package.json', content: '{}' });
  assert.equal(typeof noProject, 'string');
  assert.match(noProject, /plando/);

  // 当前还在 clarify 阶段：必须先被阶段闸门拦住（不是静默写盘）
  const early = await scaffoldDef.execute({ dir, path: 'package.json', content: '{}', techId: 't1' });
  assert.match(early, /阶段|plando/);
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
});

// 把项目推到 build 阶段（含 TECH 项 t1=user、t2=ai，一张卡），供后续用例复用。
async function pushToBuild(registered, config, dirName = 'demo') {
  const dir = path.join(config.defaultProjectDir, dirName);
  const call = async (name, args) => (await registered.find((d) => d.name === name).execute(args));
  await call('plando_project', { action: 'init', dir, name: '演示项目' });
  await call('plando_transition', {
    event: 'clarify_done',
    dir,
    payload: {
      what: '一个记单词的小网页',
      done: '打开页面能输入单词并看到保存成功',
      notDo: '不做账号系统',
      users: '我自己',
      assumptions: ['我每天会用五分钟'],
      constraints: { budget: '10 小时', platform: 'web' },
      baseline: { experience: 'some', hoursPerWeek: 5, goal: 'learn' },
    },
  });
  await call('plando_transition', { event: 'idea_ok', dir });
  await call('plando_transition', {
    event: 'tech_ok',
    dir,
    payload: {
      items: [
        { id: 't1', title: '表单', why: '要输入', ifMissing: '没法录入', owner: 'user', difficulty: 1, minutes: 60, judge: '能输入并保存', file: 'index.html' },
        { id: 't2', title: '存储', why: '要保存', ifMissing: '刷新就丢', owner: 'ai', difficulty: 2, minutes: 90, judge: '刷新后还在', file: 'app.js' },
      ],
    },
  });
  await call('plando_transition', { event: 'choose_build', dir, payload: { cards: [{ techIds: ['t1', 't2'], title: '跑通录入到保存' }] } });
  return { dir, call };
}

test('全链路：transition 成功会重渲染产物、落盘并追加 log.jsonl', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);

  assert.ok(fs.existsSync(path.join(dir, 'IDEA.md')), 'clarify_done 后应有 IDEA.md');
  assert.ok(fs.existsSync(path.join(dir, 'TECH.md')), 'tech_ok 后应有 TECH.md');
  assert.ok(fs.existsSync(path.join(dir, '.plando', 'cards', 'c1.md')), 'choose_build 后应有卡片正文');

  const logPath = path.join(dir, '.plando', 'log.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 4, `日志应有每次推进的记录，实际 ${lines.length} 行`);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(typeof entry.at, 'string');
    assert.equal(typeof entry.kind, 'string');
  }

  // 非法转移要留痕：kind=reject，且返回文本带理由
  const rejected = await call('plando_transition', { event: 'ship_pass', dir, payload: { offlineOk: true, selfChange: true, explain: 'x' } });
  assert.match(rejected, /plando：/);
  const after = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(after.some((entry) => entry.kind === 'reject' && entry.event === 'ship_pass'));
});

test('被拒的非 transition 调用也会写进 log.jsonl（REVIEW-tools M2）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);
  const logPath = path.join(dir, '.plando', 'log.jsonl');
  const before = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  // build 阶段写 scaffold 之外的路径 → 被拒；这类拒绝以前完全不记日志。
  const rejected = await call('plando_scaffold', { dir, path: 'src/app.js', content: 'x', techId: 't2' });
  assert.match(rejected, /plando：/);

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.length > before, '被拒的调用应该留痕');
  assert.ok(
    lines.some((entry) => entry.kind === 'reject' && entry.source === 'tool' && /plando：/.test(entry.reason || '')),
    '应有一条 kind=reject、source=tool 的记录',
  );
  // REVIEW-tools §9.4 N16：只有 source:'tool' 的话，多工具 / 多项目时分不清是谁被拒。
  const reject = lines.filter((entry) => entry.kind === 'reject').pop();
  assert.equal(reject.tool, 'plando_scaffold', `日志要写清是哪个工具拒的，实际 ${JSON.stringify(reject.tool)}`);
  assert.equal(reject.dir, path.resolve(dir), '日志要写清是哪个项目被拒');
});

test('被拒日志带工具名与项目 dir，多项目时能区分（REVIEW-tools N16）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);
  const logPath = path.join(dir, '.plando', 'log.jsonl');

  // 两个工具、同一个项目：靠 tool 字段区分。
  await call('plando_scaffold', { dir, path: 'src/app.js', content: 'x', techId: 't2' });
  await call('plando_card', { action: 'start', dir, id: 'nope' });
  const rejects = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'reject');
  const tools = new Set(rejects.map((entry) => entry.tool));
  assert.ok(tools.has('plando_scaffold'), `应记录 plando_scaffold，实际 ${[...tools].join(',')}`);
  assert.ok(tools.has('plando_card'), `应记录 plando_card，实际 ${[...tools].join(',')}`);
});

test('plando_card 收尾必须有证据；无证据的 done 被拒且不落盘', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);
  await call('plando_card', { action: 'start', dir, id: 'c1' });
  const noEvidence = await call('plando_card', { action: 'done', dir, id: 'c1' });
  assert.match(noEvidence, /证据|plando：/);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.plando', 'state.json'), 'utf8'));
  assert.equal(saved.cards[0].status, 'doing', '缺证据的 done 不应改状态');

  const badEvidence = await call('plando_card', { action: 'done', dir, id: 'c1', evidence: { kind: 'vibes', summary: '我懂了' } });
  assert.match(badEvidence, /证据|plando：/);

  const ok = await call('plando_card', { action: 'done', dir, id: 'c1', evidence: { kind: 'files', summary: 'index.html 能录入并保存' } });
  assert.match(ok, /已 done/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.plando', 'state.json'), 'utf8'));
  assert.equal(after.cards[0].status, 'done');
});

// REVIEW-tools §12 R3：全卡降级曾经能零产出到 done——项目里只有 IDEA.md + TECH.md，
// 没有 checks.json、没有一行用户代码，而 ship_pass 只要三句套话就过。
test('端到端：全卡降级无法推进到 ship（§12 R3）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);

  await call('plando_card', { action: 'start', dir, id: 'c1' });
  // 空话理由也不收（和 evidence 同一套判断）
  const vague = await call('plando_card', { action: 'downgrade', dir, id: 'c1', reason: '我懂了' });
  assert.match(vague, /不算理由|实际交付|plando：/);

  const down = await call('plando_card', { action: 'downgrade', dir, id: 'c1', reason: '只跑通 demo，保存功能没做' });
  assert.match(down, /降级/);

  const blocked = await call('plando_transition', { dir, event: 'cards_done' });
  assert.match(blocked, /全部降级/, `全卡降级不该放行：${blocked}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.plando', 'state.json'), 'utf8')).stage, 'build');

  // 确实做不了 → drop 是合法出口，不是死路
  const dropped = await call('plando_transition', { dir, event: 'drop', payload: { reason: 'falsified' } });
  assert.match(dropped, /drop|放弃/);
});

test('错误文本不叠两层：下层已是完整形状时原样透传（回归）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);

  // todo 卡直接 done：state/cards 返回的 reason 自带 plando：…——下一步：…
  const rejected = await call('plando_card', { action: 'done', dir, id: 'c1' });
  assert.ok(rejected.startsWith('plando：'), '必须以 plando： 开头');
  assert.equal(rejected.match(/plando：/g).length, 1, `不应出现两层 plando：前缀：${rejected}`);
  assert.equal(rejected.match(/——下一步：/g).length, 1, `不应出现两个下一步：${rejected}`);

  // 非法转移同理
  const badEvent = await call('plando_transition', { dir, event: 'cards_done' });
  assert.equal(badEvent.match(/plando：/g).length, 1, `非法转移也不该叠前缀：${badEvent}`);
});

test('端到端：check 类证据必须真有成功执行记录，自述不算（REVIEW-tools M4）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);
  await call('plando_card', { action: 'start', dir, id: 'c1' });

  fs.writeFileSync(path.join(dir, 'check-fail.mjs'), 'process.exit(1)\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'check-ok.mjs'), 'process.exit(0)\n', 'utf8');

  // ① 一次都没跑就声称「跑了检查」→ 拒
  const never = await call('plando_card', {
    action: 'done', dir, id: 'c1', evidence: { kind: 'check', summary: 'node --test 全绿，退出码 0' },
  });
  assert.match(never, /没有任何执行记录|plando：/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.plando', 'state.json'), 'utf8')).cards[0].status, 'doing');

  // ② 跑了但失败 → 不能拿失败记录当证据
  await call('plando_card', { action: 'declare', dir, id: 'c1', command: 'node check-fail.mjs' });
  await call('plando_check', { action: 'run', dir, name: 'c1' });
  const failed = await call('plando_card', {
    action: 'done', dir, id: 'c1', evidence: { kind: 'check', summary: 'node check-fail.mjs 退出码 0' },
  });
  assert.match(failed, /没通过|plando：/);

  // ③ 真跑成功了才收得掉
  await call('plando_card', { action: 'declare', dir, id: 'c1', command: 'node check-ok.mjs' });
  const ran = await call('plando_check', { action: 'run', dir, name: 'c1' });
  assert.match(ran, /退出码 0/);
  const ok = await call('plando_card', {
    action: 'done', dir, id: 'c1', evidence: { kind: 'check', summary: 'node check-ok.mjs 退出码 0' },
  });
  assert.match(ok, /已 done/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.plando', 'state.json'), 'utf8')).cards[0].status, 'done');
});

test('plando_check 只跑已声明的命令：未声明被拒、声明后能跑', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);
  const checkDef = registered.find((d) => d.name === 'plando_check');

  const undeclared = await checkDef.execute({ action: 'run', dir, name: 'c1' });
  assert.match(undeclared, /没有在 checks.json 里声明|plando：/);

  // 检查命令必须是「真实脚本 + node 文件名」：`node -e` 会被 REVIEW-tools G1 的白名单拒掉。
  fs.writeFileSync(path.join(dir, 'check-ok.mjs'), 'process.exit(0)\n', 'utf8');
  const declared = await call('plando_card', {
    action: 'declare',
    dir,
    id: 'c1',
    command: 'node check-ok.mjs',
  });
  assert.match(declared, /已为卡片 c1 声明/);

  const ran = await checkDef.execute({ action: 'run', dir, name: 'c1' });
  assert.match(ran, /检查 c1/);
  assert.match(ran, /退出码 0/);

  const listed = await checkDef.execute({ action: 'list', dir });
  assert.match(listed, /c1/);
  assert.match(listed, /node check-ok\.mjs/);
});

test('plando_card action=declare 拒绝不存在的卡 id、拒绝内联执行命令', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir, call } = await pushToBuild(registered, config);

  const ghost = await call('plando_card', { action: 'declare', dir, id: 'ghost-key', command: 'node -v' });
  assert.match(ghost, /不存在|plando：/);
  assert.equal(fs.existsSync(path.join(dir, '.plando', 'checks.json')), false, '不存在的卡不该写进 checks.json');

  const inline = await call('plando_card', { action: 'declare', dir, id: 'c1', command: 'node -e "process.exit(0)"' });
  assert.match(inline, /任意代码|不允许|plando：/);
  assert.equal(fs.existsSync(path.join(dir, '.plando', 'checks.json')), false, '危险命令不该落盘');
});

test('plando_scaffold 在 build 阶段放行 ai 项、拒绝 user 项与白名单外路径', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir } = await pushToBuild(registered, config);
  const scaffoldDef = registered.find((d) => d.name === 'plando_scaffold');

  const userOwned = await scaffoldDef.execute({ dir, path: 'package.json', content: '{"name":"demo"}', techId: 't1' });
  assert.match(userOwned, /归属|不是 ai|plando：/);
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);

  const notWhitelisted = await scaffoldDef.execute({ dir, path: 'src/app.js', content: 'x', techId: 't2' });
  assert.match(notWhitelisted, /白名单|plando：/);
  assert.equal(fs.existsSync(path.join(dir, 'src', 'app.js')), false);

  const missingTech = await scaffoldDef.execute({ dir, path: 'package.json', content: '{}', techId: 't9' });
  assert.match(missingTech, /TECH|plando：/);

  const written = await scaffoldDef.execute({ dir, path: 'package.json', content: '{"name":"demo"}', techId: 't2' });
  assert.match(written, /已写 package.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{"name":"demo"}');

  const again = await scaffoldDef.execute({ dir, path: 'package.json', content: '{"name":"demo"}', techId: 't2' });
  assert.match(again, /未重复写入/);
});

// REVIEW-tools §9.6.3 N19：`--test-reporter-destination` 这类开关是**任意文件写**。
// 这条路必须两端都断：declare 时不收，run 时（checks.json 可能被手改）再验一次。
test('端到端：写文件开关进不了检查命令，项目外的文件不会被覆盖（N19）', async (t) => {
  const { registered, config } = registerAll(t);
  const { dir } = await pushToBuild(registered, config);
  const call = async (name, args) => registered.find((d) => d.name === name).execute(args);

  // 项目外放一份「不能丢」的文件
  const outside = path.join(config.defaultProjectDir, '..', 'NOTES.md');
  fs.writeFileSync(outside, '不能丢\n', 'utf8');
  t.after(() => fs.rmSync(outside, { force: true }));
  const original = fs.readFileSync(outside, 'utf8');

  const absolute = `node --test --test-reporter=spec --test-reporter-destination=${outside}`;
  const declared = await call('plando_card', { action: 'declare', dir, id: 'c1', command: absolute });
  assert.match(declared, /任意文件写|不允许/, `declare 就该拒：${declared}`);
  assert.equal(fs.existsSync(checks.checksPath(dir)), false, '被拒的命令不该写进 checks.json');

  // 绕过 declare、手改 checks.json（模拟旧版本或用户手改）→ run 时还要再拦一次
  fs.mkdirSync(path.join(dir, '.plando'), { recursive: true });
  fs.writeFileSync(checks.checksPath(dir), JSON.stringify({ c1: { command: absolute } }), 'utf8');
  const ran = await call('plando_check', { action: 'run', dir, name: 'c1' });
  assert.match(ran, /不安全|任意文件写/, `run 时也要拒：${ran}`);
  assert.equal(fs.readFileSync(outside, 'utf8'), original, '项目外的文件必须原样不动');
});

test('终态产物：choose_handoff 渲染 HANDOFF.md，revise 渲染 CHANGE-GUIDE.md', async (t) => {
  const { registered, config } = registerAll(t);
  const call2 = async (name, args) => registered.find((d) => d.name === name).execute(args);
  const dir = path.join(config.defaultProjectDir, 'handoff-demo');
  await call2('plando_project', { action: 'init', dir, name: '交接演示' });
  await call2('plando_transition', {
    event: 'clarify_done',
    dir,
    payload: {
      what: '导出 CSV 的小脚本',
      done: '运行脚本能在当前目录看到 out.csv',
      notDo: '不做界面',
      users: '我自己',
      assumptions: ['本机有 node'],
      constraints: {},
      baseline: { experience: 'beginner', hoursPerWeek: 2, goal: 'ship' },
    },
  });
  await call2('plando_transition', { event: 'idea_ok', dir });
  const revised = await call2('plando_transition', { event: 'revise', dir, payload: { reason: '改成先做命令行版本' } });
  assert.match(revised, /tech/);
  assert.ok(fs.existsSync(path.join(dir, 'CHANGE-GUIDE.md')), 'revise 后应有 CHANGE-GUIDE.md');

  // 换一路：tech_ok → decide → 交接
  await call2('plando_transition', {
    event: 'tech_ok',
    dir,
    payload: { items: [{ id: 't1', title: 'CSV 写盘', why: '要产出文件', ifMissing: '没结果', owner: 'ai', difficulty: 1, minutes: 30, judge: '看到 out.csv', file: 'run.js' }] },
  });
  const handoff = await call2('plando_transition', { event: 'choose_handoff', dir });
  assert.match(handoff, /handoff/);
  assert.ok(fs.existsSync(path.join(dir, 'HANDOFF.md')), 'choose_handoff 后应有 HANDOFF.md');
});
