// lib/format.js —— 面向模型的文本渲染：吃数据、吐字符串。
//
// 契约来源 docs/INTERFACES.md §3：7 个函数，全是 (数据) => string，
//   不抛错（缺字段给 `—`）、不看时钟、不读文件、无副作用。
// 版式：字段名用中文、行首 `·`、不用 emoji；formatStatus ≤40 行，其余 ≤15 行。

import { STAGE_LABELS, NEXT_ACTIONS } from './state.js';

const DASH = '—';
const MAX_LINES = 15; // formatStatus 以外的行数上限

// 取一句非空文本；任何脏数据（null / 对象 / 空串）都退化成占位，绝不抛错。
function text(value, fallback = DASH) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return fallback;
}

// 字符串数组（也容忍空串、非数组），去空。
function asList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : item === null || item === undefined ? '' : String(item)))
    .filter((item) => item.length > 0);
}

// 阶段中文名；未知阶段退回原始值。
function stageLabel(stage) {
  const key = typeof stage === 'string' ? stage : '';
  if (key && Object.hasOwn(STAGE_LABELS, key)) return STAGE_LABELS[key];
  return key || DASH;
}

// 验出结果的三种取值（与 state.js 内部一致；那个常量没导出，这里不为了一个判断去改契约）。
const VERIFY_RESULTS = new Set(['pass', 'fail', 'inconclusive']);

/**
 * 下一步动作；未知阶段给通用提示。
 * 导出供 tools.js 复用同一套判断（tools.js 里「下一步」原来直接查 NEXT_ACTIONS 常量表，
 * 绕过了 decide/large 的特判）。
 * decide 阶段要分情况：契约 §3 要求 size=large 且还没验证时推荐必须是 verify，
 * 否则状态栏推荐「三选一」而 choose_build 又会被硬拦，模型读到的信息和能做的事不一致（REVIEW-state F12）。
 */
export function nextActionFor(stage, state) {
  const key = typeof stage === 'string' ? stage : '';
  if (key === 'decide' && state && typeof state === 'object') {
    const size = state.tech && state.tech.size;
    const verified = VERIFY_RESULTS.has(String(state.verify && state.verify.result));
    if (size === 'large' && !verified) return '先传 choose_verify 做一次小验证——规模是 large，不先验证不许开工';
  }
  if (key && Object.hasOwn(NEXT_ACTIONS, key)) return NEXT_ACTIONS[key];
  return '调 plando_status 确认阶段后按提示推进';
}

// 把多行文本压到最多 n 行，末行标注省略，避免把整段日志塞给模型。
// 入参可以是字符串数组（渲染时更常见）或字符串；注意不能直接 String(数组)——
// 那会用逗号拼成一行，把版式毁掉。
function capLines(raw, n) {
  const lines = Array.isArray(raw)
    ? raw.map((line) => String(line ?? ''))
    : String(raw ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= n) return lines;
  return [...lines.slice(0, Math.max(n - 1, 0)), `…（省略 ${lines.length - Math.max(n - 1, 0)} 行）`];
}

function finalize(lines) {
  return lines.filter((line) => line !== undefined && line !== null).join('\n');
}

// ---------------------------------------------------------------------------
// formatStatus({ state, projectDir, progress, pending, artifacts, budget })
// ---------------------------------------------------------------------------
export function formatStatus(input) {
  try {
    const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const state = data.state && typeof data.state === 'object' && !Array.isArray(data.state) ? data.state : {};
    const stage = state.stage;
    const lines = [];

    lines.push(`· 项目：${text(state.name, '（未命名项目）')}（${text(data.projectDir ?? state.dir)}）`);
    lines.push(`· 阶段：${stageLabel(stage)}（${text(stage)}）`);
    if (state.paused === true) lines.push('· 提醒：项目已暂停，恢复请传 plando_transition event=resume');
    lines.push(`· 下一步：${text(nextActionFor(stage, state))}`);

    // 卡进度：progress 可能来自 cards.cardProgress()，缺字段时逐项显示 —。
    const p = data.progress && typeof data.progress === 'object' ? data.progress : null;
    if (p) {
      const total = Number.isInteger(p.total) ? p.total : asList(state.cards).length;
      lines.push(
        `· 卡进度：共 ${text(total)} 张｜完成 ${text(p.done, '0')}｜降级 ${text(p.downgraded, '0')}｜进行中 ${text(p.doing, '0')}｜待开始 ${text(p.todo, '0')}｜当前 ${text(p.current, '无')}`,
      );
    } else if (Array.isArray(state.cards) && state.cards.length) {
      lines.push(`· 卡进度：共 ${state.cards.length} 张（未提供 progress 明细）`);
    }

    // 未解问题：pending 可以是字符串数组或单字符串。
    const pending = asList(data.pending);
    if (pending.length) {
      lines.push(`· 未解问题：${pending.length} 条`);
      for (const item of pending.slice(0, 5)) lines.push(`  - ${item}`);
    } else {
      lines.push('· 未解问题：无');
    }

    // 产物清单：artifacts 是字符串数组（文件名），也容忍缺省。
    const artifacts = asList(data.artifacts);
    lines.push(`· 产物：${artifacts.length ? artifacts.join('、') : '还没有生成'}`);

    // 预算余量：budget = { mustUnderstand, totalMinutes, usedMust?, usedMinutes? } 之类，尽力展示。
    const b = data.budget && typeof data.budget === 'object' ? data.budget : state.budget;
    if (b && typeof b === 'object') {
      const parts = [];
      if (b.mustUnderstand !== undefined) parts.push(`user 项上限 ${text(b.mustUnderstand)}`);
      if (b.totalMinutes !== undefined) parts.push(`总时长上限 ${text(b.totalMinutes)} 分钟`);
      if (Array.isArray(state.tech?.items)) {
        const items = state.tech.items.filter((i) => i && typeof i === 'object');
        const userCount = items.filter((i) => i.owner === 'user').length;
        const minutes = items.reduce((sum, i) => sum + (Number.isFinite(i.minutes) ? i.minutes : 0), 0);
        parts.push(`已用 user ${userCount} 条 / ${minutes} 分钟`);
      }
      lines.push(`· 预算：${parts.length ? parts.join('｜') : DASH}`);
    }

    return finalize(capLines(lines, 40));
  } catch {
    return '· 项目状态：—（读取时出错，先调 plando_status 重试）';
  }
}

// ---------------------------------------------------------------------------
// formatProjectList(list) -> [{ name, dir, stage, updatedAt, ok, reason? }]
// ---------------------------------------------------------------------------
export function formatProjectList(list) {
  try {
    const rows = Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
    if (!rows.length) return '· 还没有项目：先 plando_project action=new 立项。';
    const lines = [`· 共 ${rows.length} 个项目：`];
    for (const row of rows) {
      if (row.ok === false) {
        lines.push(`  - ${text(row.name, row.dir)}｜读不出来：${text(row.reason)}｜${text(row.dir)}`);
      } else {
        lines.push(
          `  - ${text(row.name, '（未命名项目）')}｜${stageLabel(row.stage)}｜${text(row.updatedAt, '更新时间 —')}｜${text(row.dir)}`,
        );
      }
    }
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 项目列表：—（读取时出错，先检查 projects.json 是否需要修回）';
  }
}

// ---------------------------------------------------------------------------
// formatIdeaList(ideas) -> [{ id, title, at, parked?, picked? }]
// ---------------------------------------------------------------------------
export function formatIdeaList(ideas) {
  try {
    const rows = Array.isArray(ideas) ? ideas.filter((r) => r && typeof r === 'object') : [];
    if (!rows.length) return '· 灵感库是空的：先 plando_idea action=add 记一条，不用先想清楚。';
    const lines = [`· 共 ${rows.length} 条灵感：`];
    for (const idea of rows) {
      const marks = [];
      if (idea.picked === true) marks.push('已立项');
      if (idea.parked === true) marks.push('已搁置');
      const suffix = marks.length ? `｜${marks.join('、')}` : '';
      lines.push(`  - ${text(idea.id)}｜${text(idea.title, '（无标题）')}｜${text(idea.at, '记录时间 —')}${suffix}`);
    }
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 灵感列表：—（读取时出错，先检查 ideas.json 是否需要修回）';
  }
}

// ---------------------------------------------------------------------------
// formatCard(state, card) -> 学 / 做 / 验三段现状 + 缺什么
// ---------------------------------------------------------------------------
export function formatCard(state, card) {
  try {
    const source = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
    const learn = source.learn && typeof source.learn === 'object' ? source.learn : null;
    const doPhase = source.do && typeof source.do === 'object' ? source.do : null;
    const verify = source.verify && typeof source.verify === 'object' ? source.verify : null;
    const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : null;

    const files = asList(doPhase?.files);
    const missing = [];
    // 卡里没有 action=verify 这个动作：验收走 plando_check（跑已声明的命令）+ 带证据的 done。
    // 之前这里提示 action=verify，模型会去调一个不存在的动作（REVIEW-tools M6b）。
    if (!learn) missing.push('学：写一句话学习笔记（plando_card action=learn）');
    if (!doPhase) missing.push('做：登记本次改动文件（action=do）');
    if (!evidence) missing.push('验：先 plando_check 跑检查，再 action=done 带上证据');
    if (!evidence) missing.push(`证据：${source.status === 'done' ? '缺证据的 done 不成立，补证据' : 'done 前必须有检查输出或文件变化'}`);
    const lines = [
      `· 卡 ${text(source.id)}：${text(source.title, '（未命名卡片）')}`,
      `· 状态：${text(source.status)}｜覆盖 TECH 项：${asList(source.techIds).join('、') || DASH}`,
      `· 学：${learn ? text(learn.note, '（只有时间，没有笔记）') : '未完成'}`,
      `· 做：${doPhase ? (files.length ? files.join('、') : '（没登记文件）') : '未完成'}`,
      `· 验：${evidence ? text(evidence.summary, '（已交证据）') : verify ? `退出码 ${Number.isInteger(verify.exitCode) ? verify.exitCode : DASH}` : '未完成'}`,
      `· 缺什么：${missing.length ? missing.join('；') : '无，可以收尾'}`,
    ];
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 卡片：—（渲染时出错，先调 plando_status 重新定位项目）';
  }
}

// ---------------------------------------------------------------------------
// formatTransition(ok, { event, from, to, effects, reason })
// ---------------------------------------------------------------------------
export function formatTransition(ok, detail) {
  try {
    const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
    if (ok !== true) {
      return finalize(
        capLines([`· 这次转移没成功（event=${text(d.event, '未给出')}）：${text(d.reason, '理由缺失')}`], MAX_LINES),
      );
    }
    const from = stageLabel(d.from);
    const to = d.to === null || d.to === undefined ? from : stageLabel(d.to);
    const lines = [`· 已推进：${from} → ${to}（event=${text(d.event)}）`];
    const effects = d.effects && typeof d.effects === 'object' ? d.effects : null;
    if (effects) {
      const rerender = asList(effects.rerender);
      if (rerender.length) lines.push(`· 已重渲染：${rerender.join('、')}`);
      const invalidate = asList(effects.invalidateCards);
      if (invalidate.length) lines.push(`· 已作废的卡（需重做）：${invalidate.join('、')}`);
      const note = text(effects.note, '');
      if (note) lines.push(`· 说明：${note}`);
    }
    lines.push(`· 下一步：${text(d.reason, nextActionFor(d.to, d.state))}`);
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 转移结果：—（渲染时出错，先调 plando_status 确认当前阶段）';
  }
}

// ---------------------------------------------------------------------------
// formatCheck({ ok, name, exitCode, stdout, stderr, reason })
// ---------------------------------------------------------------------------
export function formatCheck(result) {
  try {
    const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    const ok = r.ok === true || r.exitCode === 0;
    const lines = [
      `· 检查 ${text(r.name, '（未命名检查）')}：${ok ? '通过' : '未通过'}｜退出码 ${Number.isInteger(r.exitCode) ? r.exitCode : DASH}`,
    ];
    if (!ok && r.reason !== undefined) lines.push(`· 理由：${text(r.reason)}`);
    const stdout = capLines(r.stdout, 8);
    if (stdout.length && String(r.stdout ?? '').trim()) {
      lines.push('· 输出：');
      for (const line of stdout) lines.push(`  ${line}`);
    }
    const stderr = capLines(r.stderr, 3);
    if (stderr.length && String(r.stderr ?? '').trim()) {
      lines.push('· 错误输出：');
      for (const line of stderr) lines.push(`  ${line}`);
    }
    if (!ok) lines.push('· 下一步：先修到退出码 0，再把输出作为证据传给 plando_card action=done（evidence.kind=check）。');
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 检查结果：—（渲染时出错，请重跑 plando_check）';
  }
}

// ---------------------------------------------------------------------------
// formatRecover(reason, dir) —— CONTRACT §4：状态损坏时绝不重置
// ---------------------------------------------------------------------------
export function formatRecover(reason, dir) {
  try {
    const lines = [
      `· 读不出项目状态：${text(reason)}`,
      `· 项目目录：${text(dir)}`,
      '· 不要重置：不要删除或覆盖 .plando/state.json，也不要重跑 init 建新项目——那会丢掉已有历史。',
      '· 先备份：把 .plando/ 整个目录复制一份，再打开 state.json 找出坏在哪一行。',
      '· 常见修法：schemaVersion 不是整数就补回 1；JSON 少了括号就补回；文件被截断就用备份替换。',
      '· 修好后：调 plando_project action=open 重新读回，再调 plando_status 确认阶段与下一步。',
      '· 确实修不动：把 state.json 与这段报错一起交给用户，由人决定怎么恢复，不要自行重建。',
    ];
    return finalize(capLines(lines, MAX_LINES));
  } catch {
    return '· 读不出项目状态｜不要重置 .plando/state.json｜先备份再人工修回｜修好后调 plando_project action=open';
  }
}
