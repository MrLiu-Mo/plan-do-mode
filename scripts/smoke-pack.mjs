#!/usr/bin/env node
/**
 * 分发包冒烟：证明「别人装完之后能跑」，而不只是「清单里文件齐了」。
 *
 * 为什么需要它：`verify-pack.mjs` 只断言 `npm pack --dry-run` 的**清单**。
 * 清单齐了但 `lib/index.js` 里 import 了一个没进包的相对模块、或者 apply 要求
 * 一个生产环境没有的 ctx 方法——这类问题清单看不出来，装上才炸。
 *
 * 做法：
 *   1. 真打包（npm pack 到临时目录）
 *   2. 解到一个空目录（当成用户机器上的 node_modules/dsh-plan-do）
 *   3. 按 ES 模块真 import 它，用假 ctx 跑一次 apply，断言 8 个工具注册 + 1 个守卫
 *   4. 走一遍 init → clarify → clarify_done，断言 IDEA.md 落盘、守卫开始拦写工具
 *
 * 依赖 `tar`（Windows 10+ 自带 bsdtar，macOS/Linux 也都有）；没有就明确报错，不假装通过。
 *
 * 用法：node scripts/smoke-pack.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 包里必须有 / 必须没有的路径。被 verify-pack 的清单断言之外的第二道保险。 */
export function checkExtracted(root) {
  const problems = [];
  const must = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'README.md', 'README.zh.md', 'LICENSE', 'locale/zh.json'];
  const mustNot = ['test', 'scripts', path.join('docs', 'REVIEW-tools.md'), path.join('docs', 'REVIEW-state.md')];

  for (const rel of must) {
    if (!fs.existsSync(path.join(root, rel))) problems.push(`包里缺少 ${rel}`);
  }
  for (const rel of mustNot) {
    if (fs.existsSync(path.join(root, rel))) problems.push(`包里不该有 ${rel}`);
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (meta.type !== 'module') problems.push('包内 package.json 的 type 不是 module');
    if (meta.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('包内 package.json 的 dsh.bundle.patch 不对');
    if (meta.name !== 'dsh-plan-do') problems.push(`包名变了：${meta.name}`);
  } catch (error) {
    problems.push(`包内 package.json 读不出来：${error.message}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 找 npm 的 JS 入口：Windows 上直接 spawn npm.cmd 会失败，统一走 node + npm-cli.js。 */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function packInto(dir) {
  const cli = findNpmCli();
  if (!cli) throw new Error('找不到 npm-cli.js，无法打包（请确认 node 安装完整）');
  execFileSync(process.execPath, [cli, 'pack', '--pack-destination', dir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  const tgz = fs.readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack 没有产出 .tgz');
  return path.join(dir, tgz);
}

function extract(tgz, into) {
  // tar -C 要求目标目录已存在；顺手造出来，别让「目录不存在」伪装成「tar 不可用」。
  fs.mkdirSync(into, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`解包失败（需要 tar：Windows 10+ 自带）：${String(error.message || error).split('\n')[0]}`);
  }
  const root = path.join(into, 'package');
  if (!fs.existsSync(root)) throw new Error('解包后没有 package/ 目录');
  return root;
}

/** 复刻 cordis-plugin-loader 的 unwrapExports（lib/index.js，0.2.1-rc.2 实读）。
 *
 * 为什么必须在这里复刻：loader 不是直接 `apply(ns)`，它先把模块命名空间过一遍
 * `exports = exports.default ?? exports`，再 `ctx.registry.plugin(plugin, ...)`。
 * 本脚本原来直接 `mod.apply(...)`，等于跳过了这一步——于是 0.1.0 的 tgz
 * （`export default apply`，inject 被丢）能一路冒烟通过，真装上去却「加载失败」。
 * 冒烟脚本的存在意义就是「别人装完之后能跑」，所以它必须走 loader 的那条路径。
 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}

/** apply + 一遍流程。返回问题清单，不抛。 */
async function runFlow(root, work) {
  const problems = [];
  const ok = (cond, msg) => { if (!cond) problems.push(msg); };
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href);

  ok(mod.name === 'plan-do-mode', `导出 name 不对：${mod.name}`);
  ok(typeof mod.apply === 'function', 'apply 不是函数');
  ok('default' in mod === false, 'lib/index.js 导出了 default——loader 会丢掉命名 inject，装上必然「加载失败」');

  // 走 loader 的归一化，拿到它真正会交给 ctx.registry.plugin 的那个对象。
  const plugin = unwrapExports(mod);

  // 注意 `typeof fn.apply === 'function'` 永远是 true（Function.prototype.apply），
  // 所以「有 default」时裸函数能骗过 apply 检查，然后在调用处炸出一句
  // 「ctx.tools.register 不可用」——那是误导人的假原因。这里先判 inject，判不过就立刻收工，
  // 让报告里写的是真正的原因（inject 丢了），而不是下游症状。
  ok(!(typeof plugin === 'function'),
    'loader 归一化后拿到的是裸函数（模块导出了 default），命名 inject 已丢失——装上必然「加载失败」');
  ok(plugin && Array.isArray(plugin.inject) && plugin.inject.includes('tools'),
    `loader 归一化后 inject 丢了（实得 ${JSON.stringify(plugin && plugin.inject)}）——装上会报 without inject`);
  if (problems.length > 0) return problems;

  const registered = [];
  const guards = [];
  plugin.apply({ tools: { register: (def) => registered.push(def), guard: (fn) => guards.push(fn) } }, {
    dataRoot: path.join(work, 'data'),
    autoCommit: false,
  });
  ok(registered.length === 8, `注册的工具数是 ${registered.length}，应为 8`);
  ok(guards.length === 1, `守卫挂了 ${guards.length} 次，应为 1`);

  // 还没打开项目时读不到状态 → 写类必须 fail-closed，只读放行。
  const beforeOpen = guards[0]({ name: 'write' });
  ok(typeof beforeOpen === 'string' && beforeOpen.includes('fail-closed'), '无项目状态时写工具没有 fail-closed');
  ok(guards[0]({ name: 'read' }) === undefined, '无项目状态时只读工具被拦了');

  const call = (name, args) => registered.find((def) => def.name === name).execute(args);
  const projectDir = path.join(work, 'proj');

  const initOut = await call('plando_project', { action: 'init', dir: projectDir, name: '包冒烟' });
  ok(/已立项|已创建/.test(initOut), `plando_project init 输出不对：${initOut.split('\n')[0]}`);

  const clarOut = await call('plando_clarify', {
    action: 'record', kind: 'baseline', dir: projectDir,
    answers: { experience: 'some', hoursPerWeek: 4, goal: 'learn' },
  });
  ok(clarOut.includes('已记录'), `plando_clarify 输出不对：${clarOut.split('\n')[0]}`);

  const transOut = await call('plando_transition', {
    event: 'clarify_done', dir: projectDir,
    payload: {
      what: '包冒烟', done: '能跑通一步', notDo: '不多做', users: '我',
      assumptions: ['我会跑'], constraints: { platform: 'cli' },
      baseline: { experience: 'some', hoursPerWeek: 4, goal: 'learn' },
    },
  });
  ok(/已推进：clarify → idea/.test(transOut), `plando_transition 输出不对：${transOut.split('\n')[0]}`);

  const stateFile = path.join(projectDir, '.plando', 'state.json');
  ok(fs.existsSync(path.join(projectDir, 'IDEA.md')), 'IDEA.md 没有落盘');
  ok(fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).stage === 'idea', 'state.json 阶段不是 idea');

  // 有状态之后守卫要开始拦写工具，且仍然放行 plando_*。
  const denied = guards[0]({ name: 'write' });
  ok(typeof denied === 'string' && denied.startsWith('plando：'), '有状态后写工具没被拦');
  ok(guards[0]({ name: 'plando_status' }) === undefined, '守卫拦了 plando_status');

  return problems;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-smoke-'));
  const problems = [];
  try {
    const tgzDir = path.join(work, 'pkg');
    fs.mkdirSync(tgzDir);
    const tgz = packInto(tgzDir);
    const root = extract(tgz, path.join(work, 'x'));

    const extracted = checkExtracted(root);
    problems.push(...extracted.problems);
    problems.push(...await runFlow(root, work));

    const sizeKb = Math.round(fs.statSync(tgz).size / 1024);
    if (problems.length === 0) {
      console.log(`pack smoke ok: ${sizeKb} kB 包解开后能加载、能注册 8 个工具、能跑通 init→clarify→idea`);
    }
  } catch (error) {
    problems.push(String(error.message || error));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`pack smoke failed: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
