// lib/state.js —— 状态机核心：阶段 / 转移表 / payload 校验 / 推进 / 预算 / 迁移。
//
// 硬约束（见 docs/API-FACTS.md §4、docs/CONTRACT.md §1.1）：
//   1. 零依赖：本文件不 import 任何模块，只用 JS 语言能力。
//   2. 纯函数：不读文件、不写文件；applyEvent 不修改传入的 state。
//   3. 所有面向模型的错误消息走 reason() 拼，形状见 CONTRACT §5，≤160 字。

export const SCHEMA_VERSION = 1;

// §1 阶段枚举：顺序即契约顺序，测试会断言长度 11。
export const STAGES = [
  'inbox', // 灵感已记，未立项
  'clarify', // 澄清中
  'idea', // 想法定稿，写 IDEA.md
  'tech', // 技术拆解，写 TECH.md
  'decide', // 选路：小验证 / 直接做 / 交接
  'verify', // 时间盒小验证
  'build', // 边做边学，逐卡推进
  'ship', // 收尾验收
  'done', // 终态：成了
  'handoff', // 终态：交给 AI 做，人只验收
  'dropped', // 终态：证伪或搁置
];

export const TERMINAL_STAGES = ['done', 'handoff', 'dropped'];

// 非终态：drop / pause / resume 的合法 from 集合。
const NON_TERMINAL_STAGES = STAGES.filter((s) => !TERMINAL_STAGES.includes(s));

export const STAGE_LABELS = {
  inbox: '灵感收集',
  clarify: '澄清中',
  idea: '想法定稿',
  tech: '技术拆解',
  decide: '选路',
  verify: '小验证',
  build: '边做边学',
  ship: '收尾验收',
  done: '已完成',
  handoff: '已交接',
  dropped: '已放弃',
};

// 每个阶段一句话「下一步做什么」，会出现在 plando_status 和拒绝理由里。
export const NEXT_ACTIONS = {
  inbox: '用 plando_idea action=pick 立项，进入澄清',
  clarify: '用 plando_clarify record 补齐澄清，再传 clarify_done',
  idea: '确认 IDEA.md 后传 idea_ok',
  tech: '传 tech_ok，提交技术项清单',
  decide: '传 choose_verify / choose_build / choose_handoff 选一条路',
  verify: '做完时间盒验证后传 verify_result',
  build: '用 plando_card 逐张推进，全部收尾后传 cards_done',
  ship: '跑验收项后传 ship_pass',
  done: '项目已结束；要重做请传 reopen（带 reason）',
  handoff: '项目已交接；要重做请传 reopen（带 reason）',
  dropped: '项目已放弃；要重做请传 reopen（带 reason）',
};

// §2 事件表：唯一推进入口。`to: null` 表示「阶段不变」（pause / resume）。
export const TRANSITIONS = {
  clarify_done: { from: ['clarify'], to: 'idea' },
  idea_ok: { from: ['idea'], to: 'tech' },
  tech_ok: { from: ['tech'], to: 'decide' },
  choose_verify: { from: ['decide'], to: 'verify' },
  choose_build: { from: ['decide'], to: 'build' },
  choose_handoff: { from: ['decide'], to: 'handoff' },
  verify_result: { from: ['verify'], to: 'decide' },
  cards_done: { from: ['build'], to: 'ship' },
  ship_pass: { from: ['ship'], to: 'done' },
  drop: { from: [...NON_TERMINAL_STAGES], to: 'dropped' },
  revise: { from: ['idea', 'tech', 'decide', 'build'], to: 'tech' },
  pause: { from: [...NON_TERMINAL_STAGES], to: null },
  resume: { from: [...NON_TERMINAL_STAGES], to: null },
  reopen: { from: [...TERMINAL_STAGES], to: 'decide' },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`
// 超长时只截「为什么」这一段，保住前缀、破折号与「下一步」——测试会断言这三样都在。
function reason(where, why, next) {
  const head = `${where}，`;
  const tail = `——下一步：${next}`;
  const budget = 160 - 6 /* plando： */ - [...head].length - [...tail].length;
  const chars = [...String(why)];
  const whyText = chars.length <= budget ? String(why) : chars.slice(0, Math.max(budget - 1, 0)).join('') + '。';
  return `plando：${head}${whyText}${tail}`;
}

// 把「以 plando：开头」的局部理由补上「现在在哪」。
// 校验器返回的 reason 一定以 `plando：` 开头、内部带「——下一步：」，这里只插入阶段。
function withStage(stage, msg) {
  const label = STAGE_LABELS[stage] || stage;
  const head = 'plando：';
  const body = typeof msg === 'string' && msg.startsWith(head) ? msg.slice(head.length) : String(msg);
  return truncate(`${head}现在是「${label}」阶段，${body}`);
}

// §5 长度上限 160 字（按字符算，不按字节）；超长时保住末尾的「——下一步：…」。
function truncate(msg) {
  const chars = [...msg];
  if (chars.length <= 160) return msg;
  const sep = '——下一步：';
  const at = msg.indexOf(sep);
  if (at < 0) return chars.slice(0, 159).join('') + '。';
  const tail = msg.slice(at);
  const headChars = [...msg.slice(0, at)];
  const budget = Math.max(160 - [...tail].length - 1, 0);
  const head = budget >= headChars.length ? headChars.join('') : headChars.slice(0, budget).join('') + '。';
  return head + tail;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const clone = (v) => structuredClone(v);

// 当前阶段「应该先做什么」的事件名（用于拒绝信息里的下一步）。
function nextEventOf(stage) {
  const table = {
    inbox: '（先调 plando_idea action=pick 立项）',
    clarify: 'clarify_done',
    idea: 'idea_ok',
    tech: 'tech_ok',
    decide: 'choose_verify / choose_build / choose_handoff',
    verify: 'verify_result',
    build: 'cards_done（先用 plando_card 把卡收尾）',
    ship: 'ship_pass',
    done: 'reopen',
    handoff: 'reopen',
    dropped: 'reopen',
  };
  return table[stage] || '（先调 plando_status 看当前进度）';
}

function nowIso() {
  return new Date().toISOString();
}

// projectId 形状：`proj_<8位>`（约定见 CONTRACT §4）。Math.random 的 36 进制串可能不足 8 位，补足。
function makeProjectId() {
  let s = '';
  while (s.length < 8) s += Math.random().toString(36).slice(2);
  return 'proj_' + s.slice(0, 8);
}

// ---------------------------------------------------------------------------
// canTransition：纯查表，不做 payload 校验
// ---------------------------------------------------------------------------

export function canTransition(state, event) {
  const t = TRANSITIONS[event];
  if (!t) return false;
  const stage = state && state.stage;
  return Array.isArray(t.from) && t.from.includes(stage);
}

const EXPERIENCES = ['beginner', 'some', 'experienced'];
const GOALS = ['learn', 'ship'];
const OWNERS = ['user', 'follow', 'ai'];
const RESULTS = ['pass', 'fail', 'inconclusive'];
const DROP_REASONS = ['falsified', 'parked'];
// 「只说了实现/完成」这类不可观察的完成定义，见 CONTRACT §3 的启发式校验。
const VAGUE_DONE_WORDS = ['功能都实现了', '都做完了', '功能齐全', '实现了', '完成了'];
// 去掉空话后剩下的「功能 / 都 / 了」这类填充词也要去掉：契约点名的「功能都实现了」正是这种残渣。
const DONE_FILLER_WORDS = ['功能', '都', '全部', '所有', '一切', '已经', '基本', '差不多', '搞定', '弄好', '了', '的'];

function checkText(obj, key, label) {
  return isNonEmptyString(obj[key]) ? null : `${label} 不能为空`;
}

function checkStringArray(v, label, min = 1) {
  if (!Array.isArray(v) || v.length < min) return `${label} 至少需要 ${min} 条`;
  for (const s of v) if (!isNonEmptyString(s)) return `${label} 里有空项`;
  return null;
}

// done 必须是用户可观察现象，不能只写「实现了 / 完成了」。
// 判定：去掉标点 → 去掉空话词 → 去掉填充词；若只剩空串，说明整句没有可观察内容。
function checkDoneObservable(done) {
  if (typeof done !== 'string') return null; // 交给非空校验
  if ([...done].length > 200) return 'done 超过 200 字，请写成一条可观察的验收现象';
  const normalized = done.replace(/[\s，。、,.!！?？;；:：]/g, '');
  let rest = normalized;
  for (const word of [...VAGUE_DONE_WORDS, ...DONE_FILLER_WORDS]) rest = rest.split(word).join('');
  if (normalized.length > 0 && rest.length === 0) {
    return 'done 只写了「实现/完成」，请改成能看见的现象（能点开、能输入、能导出）';
  }
  return null;
}

function validateClarifyDone(payload) {
  const bad = [
    checkText(payload, 'what', 'what'),
    checkText(payload, 'done', 'done'),
    checkText(payload, 'notDo', 'notDo'),
    checkText(payload, 'users', 'users'),
    checkStringArray(payload.assumptions, 'assumptions'),
    isPlainObject(payload.constraints) ? null : 'constraints 必须是对象',
    validateBaseline(payload.baseline),
    checkDoneObservable(payload.done),
  ].filter(Boolean);
  return bad.length ? { ok: false, reason: bad[0] } : { ok: true };
}

function validateBaseline(baseline) {
  if (!isPlainObject(baseline)) return 'baseline 缺失，需要 experience / hoursPerWeek / goal';
  if (!EXPERIENCES.includes(baseline.experience)) return 'baseline.experience 必须是 beginner / some / experienced';
  const h = baseline.hoursPerWeek;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 1 || h > 60) return 'baseline.hoursPerWeek 必须是 1–60 之间的数字';
  if (!GOALS.includes(baseline.goal)) return 'baseline.goal 必须是 learn 或 ship';
  return null;
}

function validateTechItem(item, i) {
  const n = i + 1;
  if (!isPlainObject(item)) return `第 ${n} 个技术项不是对象`;
  if (item.id !== undefined && !isNonEmptyString(item.id)) return `第 ${n} 个技术项的 id 不合法`;
  const texts = [
    ['title', '技术项名'],
    ['why', '为什么需要'],
    ['ifMissing', '不会怎样错'],
    ['judge', '过关判据'],
    ['file', '落在哪个文件'],
  ];
  for (const [key, label] of texts) if (!isNonEmptyString(item[key])) return `第 ${n} 个技术项缺少${label}`;
  if (!OWNERS.includes(item.owner)) return `第 ${n} 个技术项的归属必须是 user / follow / ai`;
  if (![1, 2, 3].includes(item.difficulty)) return `第 ${n} 个技术项的难度必须是 1 / 2 / 3`;
  if (!Number.isInteger(item.minutes) || item.minutes <= 0) return `第 ${n} 个技术项的分钟数必须是正整数`;
  return null;
}

function validateTechOk(payload, config) {
  if (!Array.isArray(payload.items) || payload.items.length === 0) return { ok: false, reason: 'items 不能为空，至少提交一条技术项' };
  for (let i = 0; i < payload.items.length; i++) {
    const bad = validateTechItem(payload.items[i], i);
    if (bad) return { ok: false, reason: bad };
  }
  const budget = checkBudget(payload.items, (config && config.budget) || {});
  if (!budget.ok) return budget;
  return { ok: true };
}

function validateChooseVerify(payload) {
  const bad = [checkText(payload, 'hypothesis', 'hypothesis'), checkText(payload, 'method', 'method'), checkText(payload, 'judge', 'judge')].filter(Boolean);
  if (bad.length) return { ok: false, reason: bad[0] };
  const t = payload.timeboxMin;
  if (!Number.isInteger(t) || t < 1 || t > 60) return { ok: false, reason: 'timeboxMin 必须是 1–60 的整数' };
  return { ok: true };
}

function validateChooseBuild(payload) {
  if (!Array.isArray(payload.cards) || payload.cards.length === 0) return { ok: false, reason: 'cards 不能为空，至少拆一张卡' };
  for (let i = 0; i < payload.cards.length; i++) {
    const card = payload.cards[i];
    const n = i + 1;
    if (!isPlainObject(card)) return { ok: false, reason: `第 ${n} 张卡不是对象` };
    if (!isNonEmptyString(card.title)) return { ok: false, reason: `第 ${n} 张卡缺少标题` };
    const bad = checkStringArray(card.techIds, `第 ${n} 张卡的 techIds`);
    if (bad) return { ok: false, reason: bad };
  }
  return { ok: true };
}

function validateVerifyResult(payload) {
  if (!RESULTS.includes(payload.result)) return { ok: false, reason: 'result 必须是 pass / fail / inconclusive' };
  const bad = checkText(payload, 'evidence', 'evidence');
  return bad ? { ok: false, reason: bad } : { ok: true };
}

function validateShipPass(payload) {
  if (payload.offlineOk !== true) return { ok: false, reason: 'offlineOk 必须为 true（断网也能跑通）' };
  if (payload.selfChange !== true) return { ok: false, reason: 'selfChange 必须为 true（有一处是你自己改的）' };
  const bad = checkText(payload, 'explain', 'explain');
  return bad ? { ok: false, reason: bad } : { ok: true };
}

function validateDrop(payload) {
  if (!DROP_REASONS.includes(payload.reason)) return { ok: false, reason: 'drop 的 reason 必须是 falsified 或 parked' };
  return { ok: true };
}

function validateReasonOnly(payload) {
  const bad = checkText(payload, 'reason', 'reason');
  return bad ? { ok: false, reason: bad } : { ok: true };
}

// 与 state 无关的 payload 形状校验；依赖 state 的检查（TECH 覆盖、large 必须验证）在 applyEvent 里。
export function validatePayload(event, payload, config) {
  if (!TRANSITIONS[event]) {
    return { ok: false, reason: reason('不认识这个事件名', `不支持事件 ${String(event)}`, '先看 docs/CONTRACT.md §2 的事件表，再用 plando_transition 传合法事件') };
  }
  const p = isPlainObject(payload) ? payload : {};
  const v = (() => {
    switch (event) {
      case 'clarify_done':
        return validateClarifyDone(p);
      case 'tech_ok':
        return validateTechOk(p, config);
      case 'choose_verify':
        return validateChooseVerify(p);
      case 'choose_build':
        return validateChooseBuild(p);
      case 'verify_result':
        return validateVerifyResult(p);
      case 'ship_pass':
        return validateShipPass(p);
      case 'drop':
        return validateDrop(p);
      case 'revise':
      case 'reopen':
        return validateReasonOnly(p);
      default:
        return { ok: true }; // idea_ok / choose_handoff / cards_done / pause / resume 不需要 payload
    }
  })();
  return v.ok ? { ok: true } : { ok: false, reason: shapeOrWrap(event, v.reason) };
}

// 校验器可能已经给出完整形状（如 checkBudget），那就原样透传；否则补上统一形状。
function shapeOrWrap(event, why) {
  if (typeof why === 'string' && why.startsWith('plando：')) return why;
  return reason('事件参数不对', String(why), `按 CONTRACT §3 补齐 ${event} 的 payload 后重传`);
}

// 拒绝理由里的「为什么不行」，按事件给一句人话。
const EVENT_WHY = {
  clarify_done: '还没在澄清阶段',
  idea_ok: '想法还没定稿',
  tech_ok: '还不在技术拆解阶段',
  choose_verify: '还不能选路',
  choose_build: '还不能选路',
  choose_handoff: '还不能选路',
  verify_result: '没有进行中的验证',
  cards_done: '还没进入逐卡推进',
  ship_pass: '还没到收尾验收',
  drop: '终态项目不能再放弃',
  revise: '当前阶段不能改想法',
  pause: '终态项目不需要暂停',
  resume: '终态项目不需要恢复',
  reopen: '只有终态项目才能重开',
};

// §4 预算快照：立项时 config.budget 写进 state.budget，之后校验一律读快照，
// 这样用户改配置不会让历史项目的判定前后不一致。没有快照时退回 config（向后兼容）。
function effectiveConfig(state, config) {
  const base = isPlainObject(config) ? { ...config } : {};
  if (isPlainObject(state && state.budget)) base.budget = { ...state.budget };
  return base;
}

// 卡片必须覆盖所有 TECH 项。
function uncoveredTechIds(cards, items) {
  const covered = new Set();
  for (const c of cards) for (const id of c.techIds || []) covered.add(id);
  return (items || []).map((it) => it.id).filter((id) => !covered.has(id));
}

// IDEA 内容是否齐全（state.js 不读文件，只能检查 state.idea 的结构）。
function ideaProblems(idea) {
  if (!isPlainObject(idea)) return ['idea 数据缺失'];
  const out = [];
  if (!isNonEmptyString(idea.title)) out.push('标题');
  if (!isNonEmptyString(idea.oneLine)) out.push('一句话');
  if (!isNonEmptyString(idea.users)) out.push('谁用');
  if (!Array.isArray(idea.notDo) || idea.notDo.length === 0) out.push('什么不做');
  if (!Array.isArray(idea.mvp) || idea.mvp.length === 0) out.push('MVP');
  if (!Array.isArray(idea.acceptance) || idea.acceptance.length === 0) out.push('怎么算成');
  if (!Array.isArray(idea.assumptions) || idea.assumptions.length === 0) out.push('关键假设');
  return out;
}

function hasVerified(state) {
  return !!(state && state.verify && RESULTS.includes(state.verify.result));
}

export function applyEvent(state, event, payload, config) {
  const label = STAGE_LABELS[state && state.stage] || '未知';
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('读不到项目状态', 'state 不是对象', '先调 plando_project action=open') };
  }
  // §2.1：pick 不是状态机事件，必须指向 plando_idea。
  if (event === 'pick') {
    return { ok: false, reason: reason(`现在是「${label}」阶段`, 'pick 不是状态机事件', '立项请用 plando_idea action=pick') };
  }
  const t = TRANSITIONS[event];
  if (!t) {
    return { ok: false, reason: reason(`现在是「${label}」阶段`, `不认识事件 ${String(event)}`, '先看 docs/CONTRACT.md §2 的事件表，再调 plando_transition') };
  }
  if (!t.from.includes(state.stage)) {
    return { ok: false, reason: reason(`现在是「${label}」阶段`, EVENT_WHY[event] || `还不能执行 ${event}`, `用 plando_transition 传 ${nextEventOf(state.stage)} 推进`) };
  }
  const v = validatePayload(event, payload, effectiveConfig(state, config));
  if (!v.ok) return { ok: false, reason: withStage(state.stage, v.reason) };

  const p = isPlainObject(payload) ? payload : {};
  const draft = clone(state);
  let effects = {};

  if (event === 'clarify_done') {
    draft.idea = {
      ...(isPlainObject(draft.idea) ? draft.idea : {}),
      title: draft.idea && draft.idea.title ? draft.idea.title : draft.name,
      oneLine: p.what,
      users: p.users,
      mvp: [p.what],
      acceptance: [p.done],
      notDo: [p.notDo],
      assumptions: [...p.assumptions],
      constraints: clone(p.constraints),
    };
    draft.baseline = clone(p.baseline);
    draft.clarify = { rounds: (draft.clarify && draft.clarify.rounds) || 0, answers: (draft.clarify && draft.clarify.answers) || [], open: [] };
  } else if (event === 'idea_ok') {
    const bad = ideaProblems(draft.idea);
    if (bad.length) {
      return { ok: false, reason: reason('现在是「想法定稿」阶段', `IDEA 还缺：${bad.join('、')}`, '先用 plando_clarify record 补齐，再传 clarify_done') };
    }
  } else if (event === 'tech_ok') {
    // id 由实现分配：位置即 t1、t2……，显式带了合法 id 的就沿用（revise 后重传整份清单时靠这条稳定）。
    const items = p.items.map((it, i) => ({ ...clone(it), id: isNonEmptyString(it.id) ? it.id : `t${i + 1}` }));
    const { size, sizeReason } = computeSize(items, draft.idea && draft.idea.constraints);
    draft.tech = { items, size, sizeReason };
  } else if (event === 'choose_verify') {
    draft.verify = { hypothesis: p.hypothesis, method: p.method, timeboxMin: p.timeboxMin, judge: p.judge, result: null, evidence: '', overtime: false };
    draft.decision = { choice: 'verify', history: [...((draft.decision && draft.decision.history) || []), { choice: 'verify', at: nowIso() }] };
  } else if (event === 'choose_build') {
    const items = (draft.tech && draft.tech.items) || [];
    if (!items.length) {
      return { ok: false, reason: reason('现在是「选路」阶段', '还没有技术项清单', '先把手头做完，回 tech 传 tech_ok') };
    }
    const missing = uncoveredTechIds(p.cards, items);
    if (missing.length) {
      return { ok: false, reason: reason('现在是「选路」阶段', `卡片没覆盖技术项 ${missing.join('、')}`, '为这些技术项各拆一张卡后重传 choose_build') };
    }
    const known = new Set(items.map((it) => it.id));
    const unknown = [];
    for (const card of p.cards) for (const id of card.techIds) if (!known.has(id)) unknown.push(id);
    if (unknown.length) {
      return { ok: false, reason: reason('现在是「选路」阶段', `卡片引用了不存在的技术项 ${[...new Set(unknown)].join('、')}`, '把 card.techIds 改成 tech_ok 里真实存在的 id 后重传 choose_build') };
    }
    if (draft.tech && draft.tech.size === 'large' && !hasVerified(draft)) {
      return { ok: false, reason: reason('现在是「选路」阶段', '规模判为 large 且还没做过验证', '先传 choose_verify 做一次小验证，再回 decide 选 build') };
    }
    draft.cards = p.cards.map((card, i) => ({
      id: isNonEmptyString(card.id) ? card.id : `c${i + 1}`,
      techIds: [...card.techIds],
      title: card.title,
      status: 'todo',
      learn: null,
      do: null,
      verify: null,
      evidence: null,
      startedAt: null,
      doneAt: null,
    }));
    draft.decision = { choice: 'build', history: [...((draft.decision && draft.decision.history) || []), { choice: 'build', at: nowIso() }] };
  } else if (event === 'choose_handoff') {
    draft.decision = { choice: 'handoff', history: [...((draft.decision && draft.decision.history) || []), { choice: 'handoff', at: nowIso() }] };
  } else if (event === 'verify_result') {
    draft.verify = { ...(draft.verify || {}), result: p.result, evidence: p.evidence };
  } else if (event === 'cards_done') {
    const cards = draft.cards || [];
    if (cards.length === 0) {
      return { ok: false, reason: reason('现在是「边做边学」阶段', '还没有任何卡片', '先传 choose_build 拆卡') };
    }
    const open = cards.filter((c) => !['done', 'downgraded'].includes(c.status));
    if (open.length) {
      return { ok: false, reason: reason('现在是「边做边学」阶段', `还有 ${open.length} 张卡没收尾（${open.map((c) => c.id).join('、')}）`, '先用 plando_card done 或 downgrade 收尾，再传 cards_done') };
    }
  } else if (event === 'ship_pass') {
    draft.ship = { offlineOk: p.offlineOk, selfChange: p.selfChange, explain: p.explain };
  } else if (event === 'drop') {
    draft.terminal = { kind: 'dropped', reason: p.reason, at: nowIso() };
    draft.paused = false;
  } else if (event === 'revise') {
    const cards = draft.cards || [];
    for (const card of cards) card.status = 'stale';
    // 变更说明要能被人看到：artifacts.renderChangeGuide 读 idea.changeReason / reviseReason。
    if (draft.idea) draft.idea.changeReason = p.reason;
    draft.reviseReason = p.reason;
    effects = { rerender: ['IDEA.md', 'CHANGE-GUIDE.md'], invalidateCards: cards.map((c) => c.id) };
  } else if (event === 'reopen') {
    draft.terminal = null;
    draft.paused = false;
  } else if (event === 'pause') {
    if (draft.paused === true) return { ok: true, noop: true };
    draft.paused = true;
  } else if (event === 'resume') {
    if (draft.paused !== true) return { ok: true, noop: true };
    draft.paused = false;
  }

  if (t.to) draft.stage = t.to;
  draft.updatedAt = nowIso();

  // 成功转移后重渲染哪些产物（只给调用方提示，本文件不写文件）。
  const rerenderByEvent = {
    clarify_done: ['IDEA.md'],
    tech_ok: ['TECH.md'],
    choose_verify: ['VERIFY.md'],
    choose_build: ['cards'],
    choose_handoff: ['HANDOFF.md'],
  };
  if (!effects.rerender && rerenderByEvent[event]) effects.rerender = rerenderByEvent[event];
  const terminalByEvent = { ship_pass: 'done', choose_handoff: 'handoff', drop: 'dropped' };
  if (terminalByEvent[event]) {
    draft.terminal = { kind: terminalByEvent[event], reason: event === 'drop' ? p.reason : '', at: nowIso() };
    effects.terminal = terminalByEvent[event];
  }
  return { ok: true, state: draft, effects };
}

const DEFAULT_BUDGET = { mustUnderstand: 5, totalMinutes: 600 };

// §4 预算快照：只取正整数，缺省用契约默认值。
function resolveBudget(raw) {
  const b = isPlainObject(raw) ? raw : {};
  const must = Number.isInteger(b.mustUnderstand) && b.mustUnderstand > 0 ? b.mustUnderstand : DEFAULT_BUDGET.mustUnderstand;
  const total = Number.isInteger(b.totalMinutes) && b.totalMinutes > 0 ? b.totalMinutes : DEFAULT_BUDGET.totalMinutes;
  return { mustUnderstand: must, totalMinutes: total };
}

// §3 预算：user 条数与总分钟数的硬上限，超了要说清「超多少 / 怎么降级」。
export function checkBudget(items, budget) {
  const list = Array.isArray(items) ? items : [];
  const b = { ...DEFAULT_BUDGET, ...(isPlainObject(budget) ? budget : {}) };
  const totalMinutes = list.reduce((sum, it) => sum + (Number.isFinite(it && it.minutes) ? it.minutes : 0), 0);
  const userCount = list.filter((it) => it && it.owner === 'user').length;

  const problems = [];
  if (Number.isFinite(b.mustUnderstand) && userCount > b.mustUnderstand) {
    problems.push(`「必须自己写」有 ${userCount} 条，超出上限 ${b.mustUnderstand} 条 ${userCount - b.mustUnderstand} 条，请把 ${userCount - b.mustUnderstand} 条降级成 follow 或 ai`);
  }
  if (Number.isFinite(b.totalMinutes) && totalMinutes > b.totalMinutes) {
    problems.push(`总预计 ${totalMinutes} 分钟，超出 ${b.totalMinutes} 分钟预算 ${totalMinutes - b.totalMinutes} 分钟，请拆里程碑或砍掉 ${totalMinutes - b.totalMinutes} 分钟的量`);
  }
  if (!problems.length) return { ok: true };
  return { ok: false, reason: reason('技术清单超出预算', problems.join('；'), '降级或拆分后重新提交 tech_ok') };
}

// §3 规模判定：>180 分钟或承诺风险 → large；sizeReason 给出原因。
export function computeSize(items, constraints) {
  const list = Array.isArray(items) ? items : [];
  const totalMinutes = list.reduce((sum, it) => sum + (Number.isFinite(it && it.minutes) ? it.minutes : 0), 0);
  const promiseRisk = !!(constraints && constraints.promiseRisk === true);
  const size = totalMinutes > 180 || promiseRisk ? 'large' : 'small';
  let sizeReason = '';
  if (totalMinutes > 180) sizeReason = `预计 ${totalMinutes} 分钟`;
  else if (promiseRisk) sizeReason = '承诺风险';
  return { size, sizeReason, totalMinutes };
}

// §4 版本：已知旧版本升到当前；未知版本或形状不对 → 报错，绝不重置。
// CONTRACT 只说「已知旧版本 → migrate 升版后写回」，目前已知的旧版本只有 0（缺 schemaVersion 之前的草稿）。
export function migrate(state) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('读不到项目状态', 'state.json 不是对象', '先调 plando_project action=open；损坏时人工修回，不要重置') };
  }
  const version = state.schemaVersion;
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    return { ok: false, reason: reason('读项目状态时版本不认识', `schemaVersion 是 ${JSON.stringify(version)}，本插件只认 0 / 1`, '请升级 plando 或人工迁移，不要重置状态') };
  }
  if (version === SCHEMA_VERSION) return { ok: true, state: clone(state) };
  return { ok: true, state: upgradeFromV0(state) };
}

// v0 → v1：字段补齐（只补缺的，不覆盖已有的），并记录迁移时间。
function upgradeFromV0(state) {
  const defaults = createInitialState({ name: state.name || '未命名项目', dir: state.dir || '' });
  const merged = { ...defaults, ...clone(state) };
  if (!isPlainObject(merged.idea)) merged.idea = defaults.idea;
  else merged.idea = { ...defaults.idea, ...merged.idea };
  if (!isPlainObject(merged.clarify)) merged.clarify = defaults.clarify;
  if (!isPlainObject(merged.tech)) merged.tech = defaults.tech;
  if (!isPlainObject(merged.decision)) merged.decision = defaults.decision;
  if (!isPlainObject(merged.verify)) merged.verify = defaults.verify;
  if (!isPlainObject(merged.baseline)) merged.baseline = defaults.baseline;
  if (!isPlainObject(merged.ship)) merged.ship = defaults.ship;
  if (!Array.isArray(merged.cards)) merged.cards = [];
  if (!STAGES.includes(merged.stage)) merged.stage = 'clarify';
  merged.schemaVersion = SCHEMA_VERSION;
  merged.updatedAt = nowIso();
  return merged;
}

// §4 初始状态：一个刚立项（clarify）的项目。
export function createInitialState(project) {
  const p = isPlainObject(project) ? project : {};
  const at = nowIso();
  const name = isNonEmptyString(p.name) ? p.name : '未命名项目';
  const title = isNonEmptyString(p.title) ? p.title : name;
  const oneLine = isNonEmptyString(p.oneLine) ? p.oneLine : '';
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: isNonEmptyString(p.projectId) ? p.projectId : makeProjectId(),
    name,
    dir: isNonEmptyString(p.dir) ? p.dir : '',
    createdAt: isNonEmptyString(p.createdAt) ? p.createdAt : at,
    updatedAt: at,
    stage: 'clarify',
    paused: false,
    budget: resolveBudget(p.budget),
    idea: {
      id: isNonEmptyString(p.ideaId) ? p.ideaId : '',
      title,
      oneLine,
      users: '',
      mvp: [],
      acceptance: [],
      notDo: [],
      assumptions: [],
      constraints: {},
    },
    baseline: { experience: 'some', hoursPerWeek: 5, goal: 'learn' },
    clarify: { rounds: 0, answers: [], open: [] },
    tech: { items: [], size: 'small', sizeReason: '' },
    decision: { choice: null, history: [] },
    verify: { hypothesis: '', method: '', timeboxMin: 0, judge: '', result: null, evidence: '', overtime: false },
    cards: [],
    ship: { offlineOk: false, selfChange: false, explain: '' },
    terminal: null,
  };
}
