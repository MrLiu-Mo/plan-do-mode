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
  // 'plando：' 是 7 个字符（六个字母 + 全角冒号 U+FF1A），不是 6——写死 6 会让上界变成 161（REVIEW-state F7）。
  const budget = 160 - [...'plando：'].length - [...head].length - [...tail].length;
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

// 零宽字符不算内容：trim() 只剥 WhiteSpace，U+200B/200C/200D/2060/180E/3164 都剥不掉，
// 于是「七个字段全填 ZWSP」能通过非空校验（REVIEW-state F9）。先剥零宽再判。
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u180E\u3164]/gu;

function isNonEmptyString(v) {
  if (typeof v !== 'string') return false;
  if (v.trim().length === 0) return false;
  return v.replace(ZERO_WIDTH, '').trim().length > 0;
}

// 卡片 id 由模型通过 payload 提供，未净化会经 path.join 变成路径穿越
// （`id: '../../IDEA'` 可覆盖项目内任意文件，`../../../x` 能写到项目外，REVIEW-state F5）。
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isSafeId(v) {
  return typeof v === 'string' && CARD_ID_RE.test(v);
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
  // 零宽字符要先剥：它不在下面的标点集合里，会像「有内容」一样骗过空话判定（REVIEW-state F9）。
  const normalized = done.replace(ZERO_WIDTH, '').replace(/[\s，。、,.!！?？;；:：]/g, '');
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
    // 显式 id 必须净化且唯一：重名会让「卡片覆盖所有 TECH 项」的校验被一个名字骗过（REVIEW-state F6）。
    const explicit = payload.items[i] && payload.items[i].id;
    if (explicit !== undefined && !isSafeId(explicit)) {
      return { ok: false, reason: `第 ${i + 1} 个技术项的 id 只能用字母、数字、- 和 _，长度 1–40` };
    }
  }
  const dupTech = firstDuplicate(payload.items.map((it) => it && it.id).filter((id) => id !== undefined));
  if (dupTech) return { ok: false, reason: `技术项 id 重复：${dupTech}——删掉重复项，或给它们不同的 id` };
  const budget = checkBudget(payload.items, (config && config.budget) || {});
  if (!budget.ok) return budget;
  return { ok: true };
}

/** 返回第一个重复值，没有重复返回 null。 */
function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
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
    // 卡 id 不净化会经 path.join 变成路径穿越；重名会让重复卡永久死锁（REVIEW-state F3/F5）。
    if (card.id !== undefined) {
      if (!isSafeId(card.id)) return { ok: false, reason: `第 ${n} 张卡的 id 只能用字母、数字、- 和 _，长度 1–40` };
    }
    const bad = checkStringArray(card.techIds, `第 ${n} 张卡的 techIds`);
    if (bad) return { ok: false, reason: bad };
  }
  const dupCard = firstDuplicate(payload.cards.map((c) => c && c.id).filter((id) => id !== undefined));
  if (dupCard) return { ok: false, reason: `卡片 id 重复：${dupCard}——删掉重复的卡，或给它们不同的 id` };
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
// 规模阈值同理：生效值在 tech_ok 时写进 state.tech.threshold。
function effectiveConfig(state, config) {
  const base = isPlainObject(config) ? { ...config } : {};
  if (isPlainObject(state && state.budget)) base.budget = { ...state.budget };
  if (isPlainObject(state && state.tech) && Number.isInteger(state.tech.threshold) && state.tech.threshold > 0) {
    base.sizeThresholdMinutes = state.tech.threshold;
  }
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
    // 阈值走 effectiveConfig：state 里已有快照（立项时写入）就用快照，否则用 config 现值，
    // 都没有才退回默认 300。这样「先 tech_ok、后改配置、再 revise」不会把判定改判——与 budget 同一套路。
    const threshold = resolveSizeThreshold(effectiveConfig(draft, config).sizeThresholdMinutes);
    const { size, sizeReason } = computeSize(items, draft.idea && draft.idea.constraints, threshold);
    draft.tech = { items, size, sizeReason, threshold };
  } else if (event === 'choose_verify') {
    draft.verify = { hypothesis: p.hypothesis, method: p.method, timeboxMin: p.timeboxMin, judge: p.judge, result: null, evidence: '', overtime: false };
    draft.decision = { choice: 'verify', history: [...((draft.decision && draft.decision.history) || []), { choice: 'verify', at: nowIso() }] };
  } else if (event === 'choose_build') {
    const items = (draft.tech && draft.tech.items) || [];
    if (!items.length) {
      return { ok: false, reason: reason('现在是「选路」阶段', '还没有技术项清单', '先传 revise（带 reason）回 tech 补技术项，再 tech_ok') };
    }
    // 预算要在这里再查一遍：tech_ok 时的校验被绕过（存量 v0 迁移、手改 state）时，
    // 这是最后一道门——否则 50 条 user × 99999 分钟能一路进 build（REVIEW-state R3）。
    const overBudget = checkBudget(items, (effectiveConfig(draft, config).budget) || {});
    if (!overBudget.ok) return { ok: false, reason: withStage(draft.stage, overBudget.reason) };
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
    // 防御性取卡：调用方理论上都过了 loadState 的形状检查，但 loadState 之前
    // null 元素会让这里抛原始 TypeError——「最坏情况的兜底」不该只做在读盘侧（REVIEW-state R8）。
    const cards = (Array.isArray(draft.cards) ? draft.cards : []).filter(isPlainObject);
    if (cards.length === 0) {
      return { ok: false, reason: reason('现在是「边做边学」阶段', '还没有任何卡片', '先传 choose_build 拆卡') };
    }
    const open = cards.filter((c) => !['done', 'downgraded'].includes(c.status));
    if (open.length) {
      return { ok: false, reason: reason('现在是「边做边学」阶段', `还有 ${open.length} 张卡没收尾（${open.map((c) => c.id).join('、')}）`, '先用 plando_card done 或 downgrade 收尾，再传 cards_done') };
    }
    // 「全部降级」不等于做完了（REVIEW-tools §12 R3）：
    // 一张卡都没真收尾，阶段却推进到 ship → ship_pass 三句套话就能到 done，
    // 项目里只有 IDEA.md + TECH.md。这不是「小步跑通」，是「什么都没交付」。
    const realDone = cards.filter((c) => c.status === 'done');
    if (realDone.length === 0) {
      return {
        ok: false,
        reason: reason(
          '现在是「边做边学」阶段',
          `${cards.length} 张卡全部降级了，一行都没跑通`,
          '至少把一张卡真的做到 done（带证据），其余再降级；确实做不了就传 drop',
        ),
      };
    }
  } else if (event === 'ship_pass') {
    draft.ship = { offlineOk: p.offlineOk, selfChange: p.selfChange, explain: p.explain };
  } else if (event === 'drop') {
    draft.terminal = { kind: 'dropped', reason: p.reason, at: nowIso() };
    draft.paused = false;
  } else if (event === 'revise') {
    // 同 cards_done：别让一个 null 元素把「扩大范围」这条主路径变成 TypeError。
    const cards = (Array.isArray(draft.cards) ? draft.cards : []).filter(isPlainObject);
    for (const card of cards) card.status = 'stale';
    // 变更说明要能被人看到：artifacts.renderChangeGuide 读 idea.changeReason / reviseReason。
    if (draft.idea) draft.idea.changeReason = p.reason;
    draft.reviseReason = p.reason;
    // 假设变了，旧验证结论不再适用于新清单。不清掉的话 revise 后把范围扩到 large，
    // 「large 必须先验证」会被上一轮的 verify.result 直接放行（REVIEW-state F4）。
    draft.verify = { hypothesis: '', method: '', timeboxMin: 0, judge: '', result: null, evidence: '', overtime: false };
    effects = { rerender: ['IDEA.md', 'CHANGE-GUIDE.md', 'VERIFY.md'], invalidateCards: cards.map((c) => c.id) };
  } else if (event === 'reopen') {
    draft.terminal = null;
    draft.paused = false;
    // 重开等于换一个生命周期，旧的验证结论不该跟着复活（REVIEW-state F14）。
    draft.verify = { hypothesis: '', method: '', timeboxMin: 0, judge: '', result: null, evidence: '', overtime: false };
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

/**
 * 规模阈值的快照。历史项目里可能没有 tech.threshold（老版本写的），
 * 这时退回 config 现值、再退回默认 300——三者只在这一处归一，别在调用点各写一份。
 */
function resolveSizeThreshold(raw) {
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_SIZE_THRESHOLD_MINUTES;
}

// 快照字段的「有没有值」：立项没传就留 undefined，让 tech_ok 再按当时的 config 取一次。
function positiveIntOrUndefined(raw) {
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * 单个技术项的分钟数。老项目 / 手改的 state 里可能是字符串 `'30'`，
 * 而 `Number.isFinite('30') === false` 会让它在预算与规模判定里**同时被当成 0**——
 * 于是 TECH.md 写「总计 500 分钟、规模小」而状态机算 0，两处口径打架（REVIEW-state R4）。
 * 统一走这个函数，字符串数字也认。
 */
function minutesOf(item) {
  if (!isPlainObject(item)) return 0;
  const raw = item.minutes;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// §3 预算：user 条数与总分钟数的硬上限，超了要说清「超多少 / 怎么降级」。
export function checkBudget(items, budget) {
  const list = Array.isArray(items) ? items : [];
  const b = { ...DEFAULT_BUDGET, ...(isPlainObject(budget) ? budget : {}) };
  const totalMinutes = list.reduce((sum, it) => sum + minutesOf(it), 0);
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

// §3 规模判定：总分钟超过阈值、或承诺风险 → large；sizeReason 给出原因。
//
// 阈值默认 300（config.DEFAULT_SIZE_THRESHOLD_MINUTES 同值）：minutes 的语义是「用户亲手敲并
// 跑通的时间」，不含学概念与调试，一个带导出功能的记账工具大约 200–280 分钟，不该被判成大项目
// 而被强制先做一轮验证。阈值可由 config.sizeThresholdMinutes 覆盖，生效值在 tech_ok 时
// 快照进 state.tech.threshold（与 budget 同一套路），历史项目的判定不随改配置而漂移。
const DEFAULT_SIZE_THRESHOLD_MINUTES = 300;

export function computeSize(items, constraints, threshold) {
  const list = Array.isArray(items) ? items : [];
  const totalMinutes = list.reduce((sum, it) => sum + minutesOf(it), 0);
  const promiseRisk = !!(constraints && constraints.promiseRisk === true);
  const limit = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_SIZE_THRESHOLD_MINUTES;
  const size = totalMinutes > limit || promiseRisk ? 'large' : 'small';
  let sizeReason = '';
  if (totalMinutes > limit) sizeReason = `预计 ${totalMinutes} 分钟，超过 ${limit} 分钟阈值`;
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
  if (version === SCHEMA_VERSION) {
    // v1 也要体检：手改、坏编辑器、上一版写坏都会留下不可用的形状（REVIEW-state R2）。
    const problems = inspectShape(state);
    if (problems.length) {
      return { ok: false, reason: reason('读项目状态时结构不对', problems.join('；'), '先备份 .plando/ 再人工修回，不要重置状态') };
    }
    return { ok: true, state: clone(state) };
  }
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

  // 容器内部也要体检：只修外壳不修内容，等于把坏 state 原样升版并写回磁盘，
  // 之后 schemaVersion 变成 1、再也不会走升级分支，坏字段就被永久固化（REVIEW-state F1/F10）。
  merged.tech.items = Array.isArray(merged.tech.items) ? merged.tech.items.filter(isPlainObject) : [];
  merged.cards = merged.cards.filter(isPlainObject);
  merged.clarify.answers = Array.isArray(merged.clarify.answers) ? merged.clarify.answers.filter(isPlainObject) : [];
  merged.clarify.open = Array.isArray(merged.clarify.open) ? merged.clarify.open : [];
  merged.decision.history = Array.isArray(merged.decision.history) ? merged.decision.history.filter(isPlainObject) : [];
  for (const key of ['mvp', 'acceptance', 'notDo', 'assumptions']) {
    merged.idea[key] = Array.isArray(merged.idea[key]) ? merged.idea[key].filter(isNonEmptyString) : [];
  }
  if (!isPlainObject(merged.idea.constraints)) merged.idea.constraints = {};

  // 预算：字符串数字会让 Number.isFinite 判断整体跳过，预算门静默失效（REVIEW-state F2）。
  merged.budget = resolveBudget(merged.budget);
  merged.paused = merged.paused === true;
  merged.projectId = isNonEmptyString(merged.projectId) ? merged.projectId : makeProjectId();
  if (!isPlainObject(merged.terminal)) merged.terminal = null;
  else if (!['done', 'handoff', 'dropped'].includes(merged.terminal.kind)) merged.terminal = null;

  // 规模：缺 size 的老项目会绕过「large 必须先验证」（REVIEW-state F11）。
  // 老项目也没有 threshold 快照，按默认 300 重算——与它们当时的判定口径不同是预期内的：
  // 阈值本来就是「什么算大」的口径，旧口径只影响已经过去的项目。
  if (!['small', 'large'].includes(merged.tech.size)) {
    merged.tech.threshold = resolveSizeThreshold(merged.tech.threshold);
    const sized = computeSize(merged.tech.items, merged.idea.constraints, merged.tech.threshold);
    merged.tech.size = sized.size;
    merged.tech.sizeReason = sized.sizeReason;
  } else if (merged.tech.threshold === undefined) {
    // 已有 size 的老项目补上阈值快照，供 TECH.md 显示「超过多少」。
    merged.tech.threshold = resolveSizeThreshold(undefined);
  }

  // id 净化：老项目里可能有中文 / 带路径的 id，而 id 会被当成文件名渲染
  // （`../../README` 能覆盖用户文件，REVIEW-state R1）。迁移时统一修好并留痕。
  normalizeIds(merged);

  merged.schemaVersion = SCHEMA_VERSION;
  merged.updatedAt = nowIso();
  return merged;
}

/**
 * 把 state 里的 card / tech id 修成安全且唯一的形态。
 * 已经是安全 id 的**原样保留**（否则 revise 后重传的 techIds 会对不上）；
 * 不安全的按位置重编号（c1、c2 / t1、t2），重号的后缀去重，全部变更记进 `state.repairs`。
 * tech id 被改名时，卡上的 techIds 引用也一起改——否则「卡片覆盖所有技术项」会失效。
 * 返回 true 表示改过东西。
 */
export function normalizeIds(state) {
  if (!isPlainObject(state)) return false;
  const repairs = Array.isArray(state.repairs) ? [...state.repairs] : [];
  let changed = false;

  // 返回「旧 id → 新 id」的映射（只记真的变了的）。
  const fixList = (list, prefix) => {
    const map = new Map();
    if (!Array.isArray(list)) return map;
    const used = new Set();
    list.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      const before = item.id;
      let id = before;
      if (!isSafeId(id) || used.has(id)) {
        let n = index + 1;
        while (used.has(`${prefix}${n}`)) n += 1;
        id = `${prefix}${n}`;
        item.id = id;
        repairs.push({ kind: 'id', at: nowIso(), from: before === undefined ? '' : String(before), to: id });
        changed = true;
        if (isNonEmptyString(before)) map.set(before, id);
      }
      used.add(id);
    });
    return map;
  };

  fixList(state.cards, 'c');
  const techMap = state.tech ? fixList(state.tech.items, 't') : new Map();
  if (techMap.size > 0 && Array.isArray(state.cards)) {
    for (const card of state.cards) {
      if (!isPlainObject(card) || !Array.isArray(card.techIds)) continue;
      card.techIds = [...new Set(card.techIds.map((id) => (techMap.has(id) ? techMap.get(id) : id)))];
    }
  }
  if (changed) state.repairs = repairs;
  return changed;
}

// 读取侧的形状体检：手改、老文件、迁移都可能带进 null / 非对象元素，
// 流到工具层就变成不可读的 `Cannot read properties of null`（REVIEW-state F10）。
// 返回问题列表，空数组表示形状可用。
export function inspectShape(state) {
  if (!isPlainObject(state)) return ['state 不是对象'];
  const problems = [];
  if (!STAGES.includes(state.stage)) problems.push('stage 不在阶段枚举里');
  if (!Array.isArray(state.cards)) problems.push('cards 不是数组');
  else if (state.cards.some((c) => !isPlainObject(c))) problems.push('cards 里有非对象元素');
  // id 也要查：磁盘上的坏 id 会在渲染时经由 path.join 变成路径穿越，
  // 只在新写入路径校验等于「老项目不算数」（REVIEW-state R1）。
  else if (state.cards.some((c) => !isSafeId(c.id))) problems.push('cards 里有不合规的 id（只能用字母、数字、- 和 _，长度 1–40）');
  if (!isPlainObject(state.tech)) problems.push('tech 不是对象');
  else if (!Array.isArray(state.tech.items)) problems.push('tech.items 不是数组');
  else if (state.tech.items.some((it) => !isPlainObject(it))) problems.push('tech.items 里有非对象元素');
  else if (state.tech.items.some((it) => !isSafeId(it.id))) problems.push('tech.items 里有不合规的 id（只能用字母、数字、- 和 _，长度 1–40）');
  if (state.budget !== undefined && !isPlainObject(state.budget)) problems.push('budget 不是对象');
  return problems;
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
    // threshold：立项时由 initProject 从 config 传进来就落快照；没传（测试、老路径、手写 state）
    // 就留 undefined，tech_ok 时再按当时的 config 取——正常路径（init → tech_ok）只会有一次取值。
    tech: { items: [], size: 'small', sizeReason: '', threshold: positiveIntOrUndefined(p.sizeThresholdMinutes) },
    decision: { choice: null, history: [] },
    verify: { hypothesis: '', method: '', timeboxMin: 0, judge: '', result: null, evidence: '', overtime: false },
    cards: [],
    ship: { offlineOk: false, selfChange: false, explain: '' },
    terminal: null,
  };
}
