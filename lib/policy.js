// lib/policy.js —— 守卫的策略层：按「能力」分类工具，再按状态给出拒绝理由。
//
// 契约来源：
//   docs/INTERFACES.md §2：导出与守卫语义表（逐行落实，测试写死）。
//   PLAN.md §5：拒绝名单按能力列、不按记忆列；读永不拦；plando_* 不拦；
//               状态读不出来时写类 fail-closed、只读放行。
//   docs/API-FACTS.md §3：ctx.tools.guard() 同步、单调、exec.name 是唯一可靠字段。
//
// 硬约束：零依赖（本文件不需要任何 import）、纯函数、不碰文件系统。
// 依赖注入（getStateContext / getConfig）由 tools.js 提供，policy 只调用。

// 永远拒绝的四个能力。顺序即文档顺序，测试会逐项断言。
export const DENY_CAPS = ['fs-write', 'shell', 'dynamic-code', 'subagent'];

// 能力名单：前缀匹配覆盖「带后缀的变体」（如 write_file / bash_run / subagent_fork）。
const CAP_PREFIXES = {
  'fs-write': ['write', 'edit', 'str_replace_editor', 'apply_patch'],
  shell: ['bash', 'pwsh', 'terminal', 'shell'],
  'dynamic-code': ['run_code', 'code_interpreter', 'notebook', 'eval'],
  subagent: ['subagent', 'workflow', 'task'],
  read: ['read', 'glob', 'grep', 'list', 'search', 'web_'],
};

// 前缀匹配挡不住「前缀反过来的写法」：`fs_write`、`powershell`、`file_write` 都是 unknown，
// 会被当成「未知工具」放行（REVIEW-tools L8）。所以再加一层**词元**兜底：
// 把工具名按 `_` / `-` / 驼峰切开，任一词元命中就按对应能力处理。
const CAP_TOKENS = {
  'fs-write': ['write', 'edit', 'patch', 'mkdir', 'rmdir', 'rename', 'delete', 'remove', 'truncate', 'touch', 'chmod', 'save'],
  shell: ['shell', 'bash', 'pwsh', 'powershell', 'cmd', 'terminal', 'exec', 'spawn', 'subprocess', 'system'],
  'dynamic-code': ['eval', 'notebook', 'interpreter', 'repl'],
  subagent: ['subagent', 'workflow', 'delegate'],
};

// 读类词元：只在上面四类都没命中时用来判「读」。
const READ_TOKENS = ['read', 'glob', 'grep', 'list', 'search', 'view', 'cat', 'find', 'fetch'];

/**
 * 「记账」类名词：`todo_write` / `plan_write` / `note_write` 写的是会话里的清单与笔记，
 * 碰不到文件系统，按 fs-write 拒掉会白白废掉一个无害能力。
 * 这是**词元规则**而不是整名白名单：以后出现 `todo_add` / `plan_edit` 也照样正确。
 */
const INERT_NOUNS = ['todo', 'plan', 'note', 'memo', 'memory', 'comment', 'session', 'scratch'];

/** 把工具名切成词元：`fs_write` / `FsWrite` / `fs-write` → ['fs','write']。 */
function nameTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// 拒绝理由统一形状（CONTRACT §5）：plando：…——下一步：…，≤160 字、无 emoji。
const NEXT_FALLBACK = '先用 plando_status 确认阶段，再按当前阶段的下一步推进';

// 按字符截断且保住末尾的「——下一步：…」。
// 「下一步」本身也可能很长（nextAction 来自 state.js），所以两头都要截：
// 先给下一步留最多 60 字，剩下的预算给前半段，保证总长 ≤160。
function truncate(msg) {
  const sep = '——下一步：';
  const chars = [...msg];
  if (chars.length <= 160) return msg;
  const at = msg.indexOf(sep);
  if (at < 0) return chars.slice(0, 159).join('') + '。';
  const tailChars = [...msg.slice(at)];
  const tail = tailChars.length <= 61 ? tailChars.join('') : tailChars.slice(0, 60).join('') + '。';
  const budget = Math.max(160 - [...tail].length - 1, 0);
  const headChars = [...msg.slice(0, at)];
  const head = headChars.length <= budget ? headChars.join('') : headChars.slice(0, budget).join('') + '。';
  return head + tail;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 工具名 → 能力。返回 'fs-write'|'shell'|'dynamic-code'|'subagent'|'read'|'plando'|'unknown'。
 * 分类只看名字，不看状态（状态只影响是否拒绝）。
 */
export function classifyTool(name) {
  if (!isNonEmptyString(name)) return 'unknown';
  const lower = String(name).trim().toLowerCase();
  // plando_* 优先：它们是本插件自己的工具，自带阶段校验（PLAN §5）。
  if (lower.startsWith('plando_')) return 'plando';
  for (const cap of DENY_CAPS) {
    for (const prefix of CAP_PREFIXES[cap]) {
      if (lower.startsWith(prefix)) return cap;
    }
  }
  for (const prefix of CAP_PREFIXES.read) {
    if (lower.startsWith(prefix)) return 'read';
  }
  // 前缀没命中时按词元兜底，防止 `fs_write` / `powershell` 这类被当成未知工具放行。
  const tokens = nameTokens(lower);
  const has = (list) => tokens.some((token) => list.includes(token));
  // 记账类名词 + 写动作 → 只是会话内的清单/笔记，不碰文件，不应按 fs-write 拒。
  const inert = has(INERT_NOUNS);
  for (const cap of DENY_CAPS) {
    if (cap === 'fs-write' && inert) continue;
    if (has(CAP_TOKENS[cap])) return cap;
  }
  if (has(READ_TOKENS)) return 'read';
  return 'unknown';
}

// 把 deps 注入的 getStateContext() 结果规范化；读不出来（null / 抛错 / 形状不对）返回 null。
// 注意：stage 不是非空字符串就视为「状态读不出来」——宁可 fail-closed，也不要拿半截状态来放行。
function normalizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
  if (!isNonEmptyString(ctx.stage)) return null;
  return {
    stage: ctx.stage,
    label: isNonEmptyString(ctx.label) ? ctx.label : ctx.stage,
    nextAction: isNonEmptyString(ctx.nextAction) ? ctx.nextAction : NEXT_FALLBACK,
    paused: ctx.paused === true,
  };
}

// 能力的中文说明，用在拒绝理由里。
function capPhrase(cap) {
  if (cap === 'fs-write') return '写文件';
  if (cap === 'shell') return '执行命令';
  if (cap === 'subagent') return '委派子任务（subagent / workflow / task）';
  if (cap === 'dynamic-code') return '动态代码（run_code / notebook / eval）';
  return '能改变世界的操作';
}

// 安全地读状态上下文：getStateContext 抛错或返回非对象都当成「读不出来」（null）。
function stateCtxOrNull(getStateContext) {
  try {
    return normalizeContext(getStateContext());
  } catch {
    return null;
  }
}

/**
 * 造守卫：返回 (exec) => undefined | string。
 * deps = { getStateContext(), getConfig() }，两个都由 tools.js 注入；
 * 任何一个缺失或抛错都按「状态读不出来」处理（fail-closed）。
 */
export function createGuard(deps = {}) {
  const getStateContext = typeof deps?.getStateContext === 'function' ? deps.getStateContext : () => null;
  const getConfig = typeof deps?.getConfig === 'function' ? deps.getConfig : () => ({});

  return function guard(exec) {
    // API-FACTS §3：exec.name 是唯一可靠字段，其余字段不要假设。
    const name = exec && typeof exec === 'object' ? exec.name : undefined;
    const cap = classifyTool(name);

    // 语义表第 1 行：plando_ 前缀放行（自带阶段校验，extraDeny 也不拦）。
    if (cap === 'plando') return undefined;

    // 语义表最后一行：guardExtraDeny 点名永远拒绝，先于「读放行」判断。
    let config = {};
    try {
      config = getConfig() || {};
    } catch {
      config = {};
    }
    const extra = Array.isArray(config.guardExtraDeny) ? config.guardExtraDeny : [];
    const named = extra.some((item) => isNonEmptyString(item) && item.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (named) return truncate(extraReason(name, stateCtxOrNull(getStateContext)));

    // 语义表第 2 行：只读与未知工具放行（读永不拦：AI 要读用户代码才能验收）。
    // 放在读状态之前：读类调用不该为守卫触发一次磁盘读取。
    if (cap === 'read' || cap === 'unknown') return undefined;

    // 第 3 行：subagent / dynamic-code 永远拒绝，与状态无关（null 也拒）。
    // 第 4、5 行：fs-write / shell 有状态时带阶段与下一步，无状态时 fail-closed。
    return denyReasonFor(name, stateCtxOrNull(getStateContext));
  };
}

// guardExtraDeny 点名的理由（与 denyReasonFor 同形状）。
function extraReason(name, ctx) {
  const next = ctx ? ctx.nextAction : NEXT_FALLBACK;
  return `plando：工具「${String(name).trim()}」被配置 guardExtraDeny 点名禁用——下一步：${next}`;
}

/**
 * 生成拒绝理由：`plando：…——下一步：…`，≤160 字、无 emoji。
 * ctx = normalizeContext 的结果（null 表示状态读不出来）。
 */
export function denyReasonFor(name, ctx) {
  const cap = classifyTool(name);
  const state = normalizeContext(ctx);
  const label = state ? state.label : '';
  const next = state ? state.nextAction : NEXT_FALLBACK;
  const tool = isNonEmptyString(name) ? String(name).trim() : '（未知工具）';

  // 第 3 行：结构性拒绝——换阶段也不会放开，这点要写在理由里，免得模型反复重试。
  if (cap === 'subagent' || cap === 'dynamic-code') {
    const phrase = capPhrase(cap);
    if (!state) {
      return truncate(
        `plando：暂时读不到项目状态，本模式不挂${phrase}能力（结构性限制，换阶段也不放开）——下一步：${next}`,
      );
    }
    return truncate(
      `plando：现在是「${label}」阶段，本模式不挂${phrase}能力（结构性限制，换阶段也不放开）——下一步：${next}`,
    );
  }

  // 第 4 行：状态读不出来 → 写类 fail-closed。
  if (!state) {
    return truncate(
      `plando：暂时读不到项目状态，${capPhrase(cap)}一律先拒绝（fail-closed），以免绕过阶段校验——下一步：${next}`,
    );
  }

  // 第 5 行：有状态 → 写清阶段 + 下一步；暂停时提示先 resume。
  if (cap === 'fs-write' || cap === 'shell') {
    if (state.paused) {
      return truncate(
        `plando：现在是「${label}」阶段（项目已暂停），本模式不代写，${capPhrase(cap)}要你自己动手——下一步：先传 plando_transition event=resume 恢复，再按阶段推进`,
      );
    }
    return truncate(
      `plando：现在是「${label}」阶段，本模式不代写：${capPhrase(cap)}由你亲手完成，AI 只教与验收——下一步：${next}`,
    );
  }

  // 兜底：理论上只会被 denyReasonFor 直接调用时命中；形状仍保持一致。
  return truncate(
    `plando：本模式不允许调用工具「${tool}」（${capPhrase(cap)}）——下一步：${next}`,
  );
}
