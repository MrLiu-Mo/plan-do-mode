// lib/index.js —— plan-do-mode 插件的入口：注册 8 个工具 + 挂一次守卫。
//
// 契约（docs/INTERFACES.md §5）：
//   1. readConfig(config) 得配置；配置非法 → 抛错（宁可挂不上，也别假装能用）。
//   2. 组装 deps，调 registerTools(ctx, deps)。
//   3. ctx.tools.guard(createGuard({ getStateContext, getConfig }))，**只挂一次**。
//   4. ctx.tools.register / ctx.tools.guard 缺失 → 抛错。
//
// 零依赖（docs/API-FACTS.md §4）：只 import node: 内置模块和本目录文件，
// 绝不 import 任何 @deepseek-ai 系列裸包（link 安装解析不到，import 阶段就炸）。
//
// 阶段唯一真相源是 <项目>/.plando/state.json：getStateContext() 每次都重新读盘，不缓存。

import { readConfig } from './config.js';
import { registerTools } from './tools.js';
import { createGuard } from './policy.js';

import * as state from './state.js';
import * as project from './project.js';
import * as artifacts from './artifacts.js';
import * as cards from './cards.js';
import * as checks from './checks.js';
import * as scaffold from './scaffold.js';
import * as git from './git.js';
import * as format from './format.js';

export const name = 'plan-do-mode';

/** 只依赖工具注册表；没有它这个插件就毫无作用。 */
export const inject = ['tools'];

/**
 * 造「状态快照」给守卫用。
 * 每次调用都重新读盘：换会话、别人改了状态，守卫都能立刻反映；
 * 读不出来（没有项目 / 文件损坏）返回 null，由 policy.js 决定 fail-closed。
 *
 * 目录来源：优先最近一次 plando_* 调用用过的 dir（runtime.activeProjectDir），
 * 其次配置里的 defaultProjectDir。这里只缓存**路径**，不缓存阶段——
 * 阶段唯一真相源始终是 <dir>/.plando/state.json（INTERFACES §5）。
 *
 * @param {{ config: object, runtime: { activeProjectDir: string } }} deps
 * @returns {() => ({stage: string, label: string, nextAction: string, paused: boolean}|null)}
 */
function makeStateContext(deps) {
  return function getStateContext() {
    try {
      const active = deps.runtime && deps.runtime.activeProjectDir;
      const fallback = deps.config && deps.config.defaultProjectDir;
      const dir = typeof active === 'string' && active.trim() !== '' ? active : fallback;
      if (typeof dir !== 'string' || dir.trim() === '') return null;
      const loaded = project.loadState(dir);
      if (!loaded.ok) return null;
      const current = loaded.state;
      const stage = current && current.stage;
      if (typeof stage !== 'string') return null;
      return {
        stage,
        label: state.STAGE_LABELS[stage] || stage,
        nextAction: state.NEXT_ACTIONS[stage] || '调 plando_status 看下一步',
        paused: current.paused === true,
      };
    } catch {
      // 守卫里绝不抛错：抛了会让工具调用整体失败，比少拦一次更糟。
      return null;
    }
  };
}

/**
 * 插件入口（同步，不能 async —— preset 挂载时序不可预期）。
 * @param {object} ctx DSH 插件 ctx
 * @param {object} [config] 行里的 config
 */
export function apply(ctx, config) {
  const settings = readConfig(config);

  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('plando：ctx.tools.register 不可用，拿不到工具注册表——换一个支持工具注册的 DSH 版本。');
  }
  if (typeof ctx.tools.guard !== 'function') {
    throw new Error('plando：ctx.tools.guard 不可用，这个版本的 DSH 拦不住写文件调用——升级 DSH 后再装本插件。');
  }

  // runtime 只存「最近一次用到的项目路径」，供守卫定位状态文件；不缓存任何状态内容。
  const runtime = { activeProjectDir: '' };

  const deps = {
    config: settings,
    runtime,
    paths: project.projectPaths(settings.defaultProjectDir),
    state,
    project,
    artifacts,
    cards,
    checks,
    scaffold,
    git,
    policy: { createGuard },
    format,
  };

  registerTools(ctx, deps);

  // 守卫只挂一次：多挂会重复判、重复消耗一次磁盘读。
  ctx.tools.guard(
    createGuard({
      getStateContext: makeStateContext(deps),
      getConfig: () => settings,
    }),
  );
}

// 故意**不**导出 default。cordis-plugin-loader 的 unwrapExports 第一句就是
//   exports = exports.default ?? exports
// 一旦这里有 default，loader 会把整个插件替换成那个函数，命名导出的 inject 随之丢失，
// 插件一读 ctx.tools 就报 `cannot get property "tools" without inject`，预设里显示「加载失败」。
// 官方插件（如 @deepseek-ai/dsh-tool-todo）同样只导出命名成员。
