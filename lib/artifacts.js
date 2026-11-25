// lib/artifacts.js
// 从 state 渲染全部人读产物（纯函数：(state) => string）。
// 契约来源：docs/CONTRACT.md §4（state 形状）与 §6（产物渲染契约）。
// 硬约束：
//   - 零依赖，只允许 import node: 内置模块（本文件当前不需要任何 import）。
//   - 纯函数：同一 state 必须得到逐字节相同的字符串。禁止 Date.now()、随机数、
//     依赖 Map/对象迭代顺序的写法；所有遍历都走固定数组顺序。
// 注意：本模块只返回字符串，不写文件（落盘是 project.js 的职责）。

/** IDEA.md 固定 8 节，标题逐字（CONTRACT §6）。顺序即渲染顺序。 */
export const IDEA_HEADINGS = [
  '## 一句话',
  '## 谁用',
  '## 做什么（MVP）',
  '## 怎么算成',
  '## 什么不做',
  '## 关键假设',
  '## 约束',
  '## 用户基线',
];

/** IDEA.md 首行标题的占位记号，用于结构校验时报告「缺标题」。 */
export const IDEA_TITLE_TOKEN = '# <name>';

/** TECH.md 固定 9 列表头，逐字（CONTRACT §6）。 */
export const TECH_HEADER =
  '| id | 技术项 | 为什么需要 | 不会怎样错 | 归属 | 难度 | 分钟 | 过关判据 | 文件 |';

/** TECH.md 的固定小节标题与表头分隔行。 */
export const TECH_SEPARATOR = '|---|---|---|---|---|---|---|---|---|';
export const TECH_ITEMS_HEADING = '## 技术项清单';
export const TECH_BUDGET_HEADING = '## 预算汇总';

/** 汇总行的模板，测试与渲染共用同一份字样，避免两边各写一遍写岔。 */
export function techBudgetSummary(userCount, totalMinutes, budget) {
  return `user 项 ${userCount} 条 / 总计 ${totalMinutes} 分钟 / 预算 ${budget.mustUnderstand} 条 / ${budget.totalMinutes} 分钟`;
}

// ---------------------------------------------------------------------------
// 取值 helper：state 可能来自 clarify 半成品，字段可能是 string / string[] / null。
// ---------------------------------------------------------------------------

/** 取一句非空文本；空则给中文占位，保证产物结构稳定。 */
function text(value, fallback = '（待填写）') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 统一成字符串数组：支持 string（按换行拆）、string[]、null。 */
function asList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/** 渲染「- xxx」列表；空列表给占位，避免小节是空的。 */
function bullets(list, fallback = '- （待填写）') {
  return list.length ? list.map((item) => `- ${item}`).join('\n') : fallback;
}

/** 判断值是否为空（空串 / 空数组 / null / undefined）。 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 从枚举->中文标签的映射里取值。
 * 只用自有属性（Object.hasOwn），避免 state 里出现 'toString' / 'constructor'
 * 之类的键时命中原型链上的函数，把产物渲染成一段源码。
 */
function enumLabel(map, key, fallback) {
  if (typeof key === 'string' && Object.hasOwn(map, key)) return map[key];
  return fallback;
}

const EXPERIENCE_LABELS = {
  beginner: '新手',
  some: '有点经验',
  experienced: '熟手',
};

const GOAL_LABELS = {
  learn: '学会',
  ship: '做成能交付的东西',
};

// 约束的固定渲染顺序（不依赖对象 key 的插入顺序）。
const CONSTRAINT_FIELDS = [
  ['budget', '预算'],
  ['platform', '平台'],
  ['tech', '技术偏好'],
  ['promiseRisk', '承诺风险'],
];

/** 渲染约束值为人类可读文本。 */
function constraintValue(value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (isBlank(value)) return '';
  return text(value);
}

// ---------------------------------------------------------------------------
// IDEA.md
// ---------------------------------------------------------------------------

/** 渲染 IDEA.md；结构固定为 8 节，标题逐字。 */
export function renderIdea(state) {
  const project = state ?? {};
  const idea = project.idea ?? {};
  const baseline = project.baseline ?? {};

  const constraintLines = [];
  for (const [key, label] of CONSTRAINT_FIELDS) {
    const raw = idea.constraints?.[key];
    const value = constraintValue(raw);
    if (value) constraintLines.push(`- ${label}：${value}`);
  }

  const baselineLines = [
    `- 经验：${enumLabel(EXPERIENCE_LABELS, baseline.experience, text(baseline.experience))}`,
    `- 每周可用：${isBlank(baseline.hoursPerWeek) ? '（待填写）' : `${baseline.hoursPerWeek} 小时`}`,
    `- 目标：${enumLabel(GOAL_LABELS, baseline.goal, text(baseline.goal))}`,
  ];

  return [
    `# ${text(project.name, '（未命名项目）')}`,
    '',
    IDEA_HEADINGS[0],
    '',
    text(idea.oneLine),
    '',
    IDEA_HEADINGS[1],
    '',
    text(idea.users),
    '',
    IDEA_HEADINGS[2],
    '',
    bullets(asList(idea.mvp)),
    '',
    IDEA_HEADINGS[3],
    '',
    bullets(asList(idea.acceptance)),
    '',
    IDEA_HEADINGS[4],
    '',
    bullets(asList(idea.notDo)),
    '',
    IDEA_HEADINGS[5],
    '',
    bullets(asList(idea.assumptions)),
    '',
    IDEA_HEADINGS[6],
    '',
    constraintLines.length ? constraintLines.join('\n') : '- （待填写）',
    '',
    IDEA_HEADINGS[7],
    '',
    baselineLines.join('\n'),
    '',
  ].join('\n');
}

/**
 * 校验 IDEA.md 结构；返回缺失的标题数组，空数组表示完整。
 * 缺首行 `# <name>` 时返回 IDEA_TITLE_TOKEN。
 */
export function checkIdeaStructure(rawText) {
  return checkHeadings(rawText, IDEA_HEADINGS, { requireTitle: true });
}

/** 行级标题比对：逐字一致，只容忍行尾空白。 */
function hasHeadingLine(rawText, heading) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  return lines.some((line) => line.trimEnd() === heading);
}

/** 通用结构校验：标题 + （可选）首行一级标题。 */
function checkHeadings(rawText, headings, options = {}) {
  const missing = [];
  const source = String(rawText ?? '');
  if (options.requireTitle) {
    const lines = source.split(/\r?\n/);
    const hasTitle = lines.some((line) => /^# \S/.test(line.trimEnd()));
    if (!hasTitle) missing.push(IDEA_TITLE_TOKEN);
  }
  for (const heading of headings) {
    if (!hasHeadingLine(source, heading)) missing.push(heading);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// TECH.md
// ---------------------------------------------------------------------------

/** TECH.md 标题占位记号（校验用）。 */
export const TECH_TITLE_TOKEN = '# <name> 技术拆解';

/** 归属的固定分组顺序：user 在前（CONTRACT 要求）。 */
export const OWNER_GROUPS = [
  ['user', '必须理解并自己写'],
  ['follow', '照步骤做'],
  ['ai', '可交给 AI'],
  ['unknown', '归属未标注'],
];

const OWNER_LABELS = {
  user: 'user',
  follow: 'follow',
  ai: 'ai',
  unknown: '（未标注）',
};

/** 默认预算，与 CONTRACT §3 的 config.budget 缺省值一致。 */
const DEFAULT_BUDGET = { mustUnderstand: 5, totalMinutes: 600 };

/** 表格单元格转义：把换行压成空格，竖线换成全角，避免撑破表格。 */
function cell(value) {
  const source = value === null || value === undefined ? '' : String(value);
  const flat = source.replace(/\r?\n/g, ' ').replace(/\|/g, '｜').trim();
  return flat || '—';
}

/**
 * 读取预算。契约（Lead 定稿）：
 *   - 主来源是 state.budget（createInitialState / project 写入的快照）；
 *   - options.budget 只作测试 / 显式覆盖用，优先级更高；
 *   - 两者都读不到时回落到 CONTRACT §3 的缺省值 5 条 / 600 分钟。
 */
function readBudget(state, options) {
  const raw = options?.budget ?? state?.budget ?? {};
  const mustUnderstand = Number.isInteger(raw.mustUnderstand) && raw.mustUnderstand >= 0
    ? raw.mustUnderstand
    : DEFAULT_BUDGET.mustUnderstand;
  const totalMinutes = Number.isInteger(raw.totalMinutes) && raw.totalMinutes >= 0
    ? raw.totalMinutes
    : DEFAULT_BUDGET.totalMinutes;
  return { mustUnderstand, totalMinutes };
}

/** 把 TECH 项按归属分组，保持每组内的原始相对顺序。 */
function groupByOwner(items) {
  const buckets = new Map(OWNER_GROUPS.map(([owner]) => [owner, []]));
  for (const item of items) {
    const owner = enumLabel(OWNER_LABELS, item?.owner, null) ? item.owner : 'unknown';
    buckets.get(owner).push(item);
  }
  return buckets;
}

/**
 * 渲染 TECH.md：固定 9 列表格、按 owner 分组（user 在前）、表下汇总预算。
 * @param {object} state CONTRACT §4 的 state
 * @param {{budget?: {mustUnderstand:number,totalMinutes:number}}} [options]
 */
export function renderTech(state, options = {}) {
  const project = state ?? {};
  const items = Array.isArray(project.tech?.items) ? project.tech.items : [];
  const totalMinutes = items.reduce((sum, item) => {
    const minutes = Number(item?.minutes);
    return sum + (Number.isFinite(minutes) && minutes > 0 ? minutes : 0);
  }, 0);
  const userCount = items.filter((item) => item?.owner === 'user').length;
  const budget = readBudget(project, options);

  const lines = [`# ${text(project.name, '（未命名项目）')} 技术拆解`, '', TECH_ITEMS_HEADING, ''];
  lines.push('按「归属」分组：user 在前，follow 次之，ai 最后。', '');

  const buckets = groupByOwner(items);
  for (const [owner, ownerNote] of OWNER_GROUPS) {
    const groupItems = buckets.get(owner);
    if (!groupItems.length) continue;
    lines.push(`### 归属 ${owner}（${ownerNote}）`, '');
    lines.push(TECH_HEADER, TECH_SEPARATOR);
    for (const item of groupItems) {
      const cells = [
        cell(item?.id),
        cell(item?.title),
        cell(item?.why),
        cell(item?.ifMissing),
        cell(enumLabel(OWNER_LABELS, owner, OWNER_LABELS.unknown)),
        cell(item?.difficulty),
        cell(item?.minutes),
        cell(item?.judge),
        cell(item?.file),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  if (!items.length) {
    // 没有 TECH 项时也把 9 列表头摆出来，保证结构校验不因「没数据」而失败。
    lines.push(TECH_HEADER, TECH_SEPARATOR, '');
    lines.push('（还没有 TECH 项：先用 plando_transition 传 tech_ok。）', '');
  }

  lines.push(TECH_BUDGET_HEADING, '');
  lines.push(`- ${techBudgetSummary(userCount, totalMinutes, budget)}`);
  const size = project.tech?.size;
  if (size === 'small' || size === 'large') {
    const reason = text(project.tech?.sizeReason, '');
    lines.push(`- 规模：${size === 'large' ? '大' : '小'}${reason ? `（${reason}）` : ''}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 校验 TECH.md 结构；返回缺失的标题/表头数组，空数组表示完整。
 * 顺序：一级标题、清单小节、9 列表头、表头分隔行、预算小节。
 */
export function checkTechStructure(rawText) {
  const source = String(rawText ?? '');
  const lines = source.split(/\r?\n/);
  const missing = [];
  if (!lines.some((line) => line.trimEnd() === TECH_TITLE_TOKEN || /^# \S.* 技术拆解$/.test(line.trimEnd()))) {
    missing.push(TECH_TITLE_TOKEN);
  }
  for (const token of [TECH_ITEMS_HEADING, TECH_HEADER, TECH_SEPARATOR, TECH_BUDGET_HEADING]) {
    if (!lines.some((line) => line.trimEnd() === token)) missing.push(token);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// VERIFY.md / HANDOFF.md / CHANGE-GUIDE.md
// 这三份的结构由 artifacts.js 自己定（CONTRACT §6 允许），但必须稳定可读。
// ---------------------------------------------------------------------------

export const VERIFY_HEADINGS = [
  '## 要验证的假设',
  '## 怎么验（方法）',
  '## 时间盒',
  '## 什么算通过',
  '## 结果',
];

export const HANDOFF_HEADINGS = [
  '## 交给 AI 做什么',
  '## 用户只负责验收',
  '## 验收标准',
  '## 明确不做',
  '## 相关文件与清单',
];

export const CHANGE_GUIDE_HEADINGS = [
  '## 这次改了什么',
  '## 受影响的卡',
  '## 需要重做的部分',
  '## 下一步',
];

const RESULT_LABELS = {
  pass: '通过',
  fail: '没通过',
  inconclusive: '结论不明确',
};

const CHOICE_LABELS = {
  verify: '小验证',
  build: '直接做',
  handoff: '交给 AI 做',
};

/** 渲染 VERIFY.md：小验证的时间盒、判据与结果。 */
export function renderVerify(state) {
  const project = state ?? {};
  const verify = project.verify ?? {};
  const timebox = Number(verify.timeboxMin);

  const lines = [`# ${text(project.name, '（未命名项目）')} 小验证`, ''];
  lines.push(VERIFY_HEADINGS[0], '', text(verify.hypothesis), '');
  lines.push(VERIFY_HEADINGS[1], '', text(verify.method), '');
  lines.push(VERIFY_HEADINGS[2], '');
  lines.push(`- 时间盒：${Number.isFinite(timebox) && timebox > 0 ? `${timebox} 分钟` : '（待填写）'}`);
  lines.push(`- 是否超时：${verify.overtime === true ? '是（该停下来，回 decide 重选）' : '否'}`);
  lines.push('');
  lines.push(VERIFY_HEADINGS[3], '', text(verify.judge), '');
  lines.push(VERIFY_HEADINGS[4], '');
  if (isBlank(verify.result)) {
    lines.push('- 结果：（还没记录：用 plando_transition 传 verify_result）');
    lines.push('- 证据：（待填写）');
  } else {
    lines.push(`- 结果：${enumLabel(RESULT_LABELS, verify.result, text(verify.result))}`);
    lines.push(`- 证据：${text(verify.evidence)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染 HANDOFF.md：把「交给 AI 做、人只验收」写成可执行的交接单。 */
export function renderHandoff(state) {
  const project = state ?? {};
  const idea = project.idea ?? {};
  const items = Array.isArray(project.tech?.items) ? project.tech.items : [];
  const aiItems = items.filter((item) => item?.owner === 'ai');

  const lines = [`# ${text(project.name, '（未命名项目）')} 交接单`, ''];
  lines.push(HANDOFF_HEADINGS[0], '');
  lines.push(`- 一句话：${text(idea.oneLine)}`);
  lines.push(`- 谁用：${text(idea.users)}`);
  if (project.tech?.size === 'small' || project.tech?.size === 'large') {
    const reason = text(project.tech?.sizeReason, '');
    lines.push(`- 规模：${project.tech.size === 'large' ? '大' : '小'}${reason ? `（${reason}）` : ''}`);
  }
  lines.push('');
  lines.push(HANDOFF_HEADINGS[1], '');
  lines.push('用户不写实现代码，只做三件事：跑验收、看现象、决定收不收。', '');
  lines.push(HANDOFF_HEADINGS[2], '');
  lines.push(bullets(asList(idea.acceptance)));
  lines.push('');
  lines.push(HANDOFF_HEADINGS[3], '');
  lines.push(bullets(asList(idea.notDo)));
  lines.push('');
  lines.push(HANDOFF_HEADINGS[4], '');
  if (aiItems.length) {
    lines.push('交给 AI 的 TECH 项：', '');
    for (const item of aiItems) {
      lines.push(`- ${text(item?.id)} ${text(item?.title)}（落在 ${text(item?.file)}，判据：${text(item?.judge)}）`);
    }
  } else {
    lines.push('- 没有标记为「ai」的 TECH 项：若确实要整套交接，先在 tech_ok 里把归属补准。');
  }
  lines.push('');
  lines.push('产物清单：IDEA.md、TECH.md、HANDOFF.md、`' + '.plando/state.json' + '`、`' + '.plando/log.jsonl' + '`', '');
  return lines.join('\n');
}

/** 渲染 CHANGE-GUIDE.md：想法变更后，告诉人哪些地方要重做。 */
export function renderChangeGuide(state) {
  const project = state ?? {};
  const idea = project.idea ?? {};
  const cards = Array.isArray(project.cards) ? project.cards : [];
  const staleCards = cards.filter((card) => card?.status === 'stale');
  const history = Array.isArray(project.decision?.history) ? project.decision.history : [];

  const lines = [`# ${text(project.name, '（未命名项目）')} 变更指南`, ''];
  lines.push(CHANGE_GUIDE_HEADINGS[0], '');
  lines.push(`- 现在的一句话：${text(idea.oneLine)}`);
  lines.push(`- 变更说明：${text(idea.changeReason ?? project.reviseReason)}`);
  lines.push('');
  lines.push(CHANGE_GUIDE_HEADINGS[1], '');
  if (staleCards.length) {
    for (const card of staleCards) {
      lines.push(`- ${text(card?.id)} ${text(card?.title)}（需要重做）`);
    }
  } else {
    lines.push('- 没有卡被作废。');
  }
  lines.push('');
  lines.push(CHANGE_GUIDE_HEADINGS[2], '');
  lines.push('- 重做前先跑一次 plando_status，确认现在在哪个阶段。');
  lines.push('- 受影响的 TECH 项要重新过一遍判据，别只补文档。');
  lines.push('');
  lines.push(CHANGE_GUIDE_HEADINGS[3], '');
  const lastChoice = history.length ? history[history.length - 1]?.choice : null;
  lines.push(`- 上次选路：${lastChoice ? enumLabel(CHOICE_LABELS, lastChoice, text(lastChoice)) : '（还没选路）'}`);
  lines.push('- 下一步：用 plando_transition 传 tech_ok 重新确认清单，再回 decide 选路。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 卡片正文 <项目>/.plando/cards/<id>.md
// 契约：必须含「学 / 做 / 验」三段小标题，且每段都落成可执行判据（CONTRACT §6）。
// ---------------------------------------------------------------------------

export const CARD_SECTIONS = ['## 学', '## 做', '## 验'];

const CARD_STATUS_LABELS = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  downgraded: '已降级',
  stale: '已作废（需重做）',
};

/** 取出卡片覆盖的 TECH 项（保持 techIds 的顺序，找不到就跳过）。 */
function cardTechItems(state, card) {
  const items = Array.isArray(state?.tech?.items) ? state.tech.items : [];
  const ids = asList(card?.techIds);
  if (!ids.length) return [];
  const byId = new Map();
  for (const item of items) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** 把非空文本渲染成「- 前缀：值」，空则给占位行。 */
function labeled(prefix, value, fallback = '（待填写）') {
  return `- ${prefix}：${isBlank(value) ? fallback : text(value)}`;
}

/** 渲染单张卡片正文；纯函数，同一 (state, card) 逐字节相同。 */
export function renderCard(state, card) {
  const source = card ?? {};
  const techItems = cardTechItems(state, source);
  const techIds = asList(source.techIds);
  const learn = source.learn ?? null;
  const doPhase = source.do ?? null;
  const verify = source.verify ?? null;
  const evidence = source.evidence ?? null;

  const techTitles = techItems.map((item) => text(item.title)).join('、');
  const techFiles = [];
  for (const item of techItems) {
    for (const file of asList(item.file)) techFiles.push(file);
  }

  const lines = [`# ${text(source.title, '（未命名卡片）')}`, ''];
  lines.push(`- 卡 id：${text(source.id, '（无 id）')}`);
  lines.push(
    `- 覆盖 TECH 项：${techIds.length ? techIds.join(', ') : '（无）'}${techTitles ? `（${techTitles}）` : ''}`,
  );
  lines.push(`- 状态：${enumLabel(CARD_STATUS_LABELS, source.status, text(source.status))}`);
  lines.push(`- 开始时间：${isBlank(source.startedAt) ? '（未开始）' : text(source.startedAt)}`);
  lines.push(`- 完成时间：${isBlank(source.doneAt) ? '（未完成）' : text(source.doneAt)}`);
  lines.push('');

  // 学
  lines.push(CARD_SECTIONS[0], '');
  lines.push('判据：能用自己的话讲清这几个 TECH 项为什么需要它、不用会怎样错。', '');
  if (techItems.length) {
    for (const item of techItems) {
      lines.push(`- ${text(item.title)}：不用它就会「${text(item.ifMissing)}」`);
    }
  } else {
    lines.push('- （这张卡还没挂 TECH 项，先把归属和判据补上）');
  }
  lines.push(labeled('学习笔记', learn?.note, '（待填写：写一句话总结，不接受只写「我懂了」）'));
  lines.push(labeled('记录时间', learn?.at, '（未记录）'));
  lines.push('');

  // 做
  lines.push(CARD_SECTIONS[1], '');
  lines.push('判据：下面的文件里出现你自己写的改动，且能指出每处改动的意图。', '');
  const doFiles = asList(doPhase?.files).length ? asList(doPhase?.files) : techFiles;
  lines.push(bullets(doFiles.map((file) => `改/新增：${file}`), '- 涉及文件：（待填写）'));
  lines.push(labeled('记录时间', doPhase?.at, '（未记录）'));
  lines.push('');

  // 验
  lines.push(CARD_SECTIONS[2], '');
  lines.push('判据：跑一次可复现的检查，贴出输出与退出码；退出码 0 才算过。', '');
  if (techItems.length) {
    for (const item of techItems) lines.push(`- 过关判据：${text(item.judge)}`);
  } else {
    lines.push('- 过关判据：（这张卡还没挂 TECH 项，先补判据）');
  }
  lines.push(labeled('检查输出', verify?.output, '（待填写：贴实际输出，不接受「应该没问题」）'));
  lines.push(`- 退出码：${Number.isInteger(verify?.exitCode) ? verify.exitCode : '（未记录）'}`);
  lines.push(labeled('记录时间', verify?.at, '（未记录）'));
  lines.push('');

  // 证据（卡片完成的唯一凭据）
  lines.push('## 证据', '');
  if (evidence) {
    lines.push(`- 类型：${evidence.kind === 'files' ? '文件变化' : '检查输出'}`);
    lines.push(labeled('摘要', evidence.summary, '（待填写）'));
    lines.push(labeled('记录时间', evidence.at, '（未记录）'));
  } else {
    lines.push('- 还没有证据：卡片不能标 done（plando_card done 会被拒）。');
  }
  lines.push('');

  return lines.join('\n');
}
