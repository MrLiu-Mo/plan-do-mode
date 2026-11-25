// test/index.test.js —— lib/index.js：apply() 挂 8 个工具 + 一个守卫；零依赖静态扫描。
//
// 断言重点（task-8 / API-FACTS §5）：
//   1. apply(fakeCtx().ctx, {}) 后注册 8 个工具，guards.length === 1。
//   2. guards[0]({name:'write'}) 是字符串（拒绝理由）、read / plando_* 是 undefined。
//   3. ctx.tools.guard 缺失时 apply 抛错（宁可挂不上，也别假装拦住了）。
//   4. 静态扫描 lib/*.js：只允许 node: 内置模块与相对路径 import（语句级正则，
//      避免 lib/artifacts.js 注释里的 "import" 误报）。
// 临时目录一律 fs.mkdtempSync(os.tmpdir())，绝不写 ~/.plando。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(HERE, '..', 'lib');

// Windows 上 import() 绝对路径必须先转 file:// URL（API-FACTS §5）。
const mod = await import(pathToFileURL(path.join(LIB_DIR, 'index.js')).href);

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeCtx() {
  const registered = [];
  const guards = [];
  return {
    registered,
    guards,
    ctx: { tools: { register: (def) => registered.push(def), guard: (fn) => guards.push(fn) } },
  };
}

// 一份把数据目录全指到临时目录的配置，避免 apply 读写真实 ~/.plando。
function tmpConfig(root) {
  return {
    dataRoot: path.join(root, 'data'),
    defaultProjectDir: path.join(root, 'projects'),
    budget: { mustUnderstand: 5, totalMinutes: 600 },
    autoCommit: false,
    guardExtraDeny: [],
  };
}

test('模块契约：name / inject / apply 都按 API-FACTS §1 导出', () => {
  assert.equal(mod.name, 'plan-do-mode');
  assert.deepEqual(mod.inject, ['tools']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.apply.constructor.name, 'Function');
  // apply 必须同步：不能是 async（API-FACTS §7「apply 写成 async」是已知坑）
  assert.equal(mod.apply.constructor.name === 'AsyncFunction', false);
});

test('apply 后注册 8 个工具，且 guards.length === 1', (t) => {
  const root = tmpRoot(t);
  const { ctx, registered, guards } = fakeCtx();
  mod.apply(ctx, tmpConfig(root));
  assert.equal(registered.length, 8);
  assert.deepEqual(registered.map((def) => def.name).sort(), [
    'plando_card',
    'plando_check',
    'plando_clarify',
    'plando_idea',
    'plando_project',
    'plando_scaffold',
    'plando_status',
    'plando_transition',
  ]);
  assert.equal(guards.length, 1);
  assert.equal(typeof guards[0], 'function');
});

test('守卫语义：write 被拒且理由是字符串，read / plando_status 放行', (t) => {
  const root = tmpRoot(t);
  const { ctx, guards } = fakeCtx();
  mod.apply(ctx, tmpConfig(root));

  const writeReason = guards[0]({ name: 'write' });
  assert.equal(typeof writeReason, 'string');
  assert.ok(writeReason.length > 0);
  assert.match(writeReason, /^plando：/);
  assert.match(writeReason, /下一步/);

  assert.equal(guards[0]({ name: 'read' }), undefined);
  assert.equal(guards[0]({ name: 'glob' }), undefined);
  assert.equal(guards[0]({ name: 'plando_status' }), undefined);
  assert.equal(guards[0]({ name: 'plando_transition' }), undefined);

  // 结构性拒绝：subagent / run_code 与阶段无关
  assert.equal(typeof guards[0]({ name: 'subagent' }), 'string');
  assert.equal(typeof guards[0]({ name: 'bash' }), 'string');
  // 奇怪输入不抛错；未知工具按 INTERFACES §2 放行（unknown → undefined）
  assert.equal(guards[0]({}), undefined);
  assert.equal(guards[0](undefined), undefined);
  assert.equal(guards[0]({ name: 'some_unknown_tool' }), undefined);
});

test('apply 传入缺 tools.guard 的 ctx 时抛错', (t) => {
  const root = tmpRoot(t);
  const registerOnly = { tools: { register: () => {} } };
  assert.throws(() => mod.apply(registerOnly, tmpConfig(root)), /guard/);
});

test('apply 传入缺 tools.register 的 ctx 时抛错', (t) => {
  const root = tmpRoot(t);
  const guardOnly = { tools: { guard: () => {} } };
  assert.throws(() => mod.apply(guardOnly, tmpConfig(root)), /register/);
});

test('apply 传入非法配置时抛中文错误，而不是静默失败', () => {
  const { ctx } = fakeCtx();
  assert.throws(() => mod.apply(ctx, { budget: { mustUnderstand: -1 } }), /plando：配置/);
  assert.throws(() => mod.apply(ctx, '不是对象'), /plando：配置/);
});

test('getStateContext 每次都重新读盘：项目建好后才拦得住写工具', async (t) => {
  const root = tmpRoot(t);
  const config = tmpConfig(root);
  const { ctx, guards } = fakeCtx();
  mod.apply(ctx, config);

  // 状态读不出来 → 写类 fail-closed，照样拒绝（PLAN §5）
  assert.equal(typeof guards[0]({ name: 'write' }), 'string');

  // 真建一个项目，再问一次：守卫应该带上阶段名
  const project = await import(pathToFileURL(path.join(LIB_DIR, 'project.js')).href);
  project.initProject(config.defaultProjectDir, { name: '守卫测试', budget: config.budget });
  const reason = guards[0]({ name: 'write' });
  assert.equal(typeof reason, 'string');
  assert.match(reason, /澄清|clarify/);
});

test('守卫跟随「最近一次 plando_* 用到的 dir」，而不是只看 defaultProjectDir', async (t) => {
  const root = tmpRoot(t);
  const config = tmpConfig(root);
  const { ctx, registered, guards } = fakeCtx();
  mod.apply(ctx, config);

  const project = await import(pathToFileURL(path.join(LIB_DIR, 'project.js')).href);
  const other = path.join(root, '别处项目');
  project.initProject(other, { name: '别处', budget: config.budget });
  // 把别处项目推到 tech 阶段，好在拒绝理由里区分出阶段
  const status = registered.find((def) => def.name === 'plando_status');
  const out = await status.execute({ dir: other });
  assert.equal(typeof out, 'string');

  const reason = guards[0]({ name: 'write' });
  assert.equal(typeof reason, 'string');
  assert.match(reason, /澄清|clarify/, '守卫应读到别处项目的状态，而不是 defaultProjectDir 的状态');
});

test('零依赖静态扫描：lib/*.js 只 import node: 内置模块与相对路径', () => {
  const files = fs.readdirSync(LIB_DIR).filter((file) => file.endsWith('.js'));
  assert.ok(files.length >= 10, `lib/ 下应该有一整套模块，实际 ${files.length} 个`);

  // 语句级正则：行首（允许缩进）的 import … from '…'、裸 require( … )、import( '…' )。
  // 用语句级而不是纯文本搜索：lib/artifacts.js 注释里出现过 "import" 这个词。
  const importFrom = /(^|\n)[ \t]*import[^\n]*?from[ \t]*['"]([^'"]+)['"]/g;
  const bareImport = /(^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g;
  const requireCall = /(^|\n)[ \t]*(?:const|let|var)?[^\n]*?\brequire\([ \t]*['"]([^'"]+)['"]/g;
  const dynamicImport = /(^|\n)[ \t]*[^\n]*?\bimport\([ \t]*['"]([^'"]+)['"]/g;

  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    for (const pattern of [importFrom, bareImport, requireCall, dynamicImport]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const spec = match[2];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        offenders.push(`${file}: ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `出现了裸包名 import：\n${offenders.join('\n')}`);

  // 另外硬拦真正的裸包名引用（注释里提到包名不算：只在 import 语句里查）
  for (const file of files) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert.equal(
      /(^|\n)[ \t]*import[^\n]*?from[ \t]*['"]@deepseek-ai\//.test(source),
      false,
      `${file} 的 import 语句不应引用 @deepseek-ai/*`,
    );
  }
});

test('裸 node 能直接 import lib/index.js（零依赖真的成立）', async () => {
  const fresh = await import(`${pathToFileURL(path.join(LIB_DIR, 'index.js')).href}?fresh=1`);
  assert.equal(fresh.name, 'plan-do-mode');
  assert.equal(typeof fresh.apply, 'function');
});
