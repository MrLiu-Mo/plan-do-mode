// lib/cards.js
// 逐卡推进（build 阶段）：Card 的纯函数状态变换。
// 契约来源：docs/CONTRACT.md §4（Card 形状）与 §5（错误消息形状）。
// 硬约束：
//   - 零依赖：本文件不需要任何 import（只用 Node 全局 structuredClone）。
//   - 纯函数：每个函数先 structuredClone(state) 再改，传入的 state 逐字节不变。
//   - 不写文件、不渲染产物（落盘是 project.js / index.js 的职责）。
// 说明：不修改 state.updatedAt —— 时间戳由调用方在存盘前统一写，避免同一 state
// 两次调用得到不同结果（纯函数可复现）。

/** 处于「已收尾」的两态；卡片进度与 cards_done 闸门都按这两态判断。 */
const CLOSED = ['done', 'downgraded'];

/** 允许 startCard 的源状态：todo 首次开工，stale 是 revise 后重做。 */
const STARTABLE = ['todo', 'stale'];

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`。
// 与 state.js 的 reason() 保持同一形状（超长时只截「为什么」，保住前后两段）。
function reason(why, next) {
  const head = '现在是「边做边学」阶段，';
  const tail = `——下一步：${next}`;
  // 'plando：' 是 7 个字符（六个字母 + 全角冒号），写成 6 会让上界变成 161（REVIEW-state F7）。
  const budget = 160 - [...'plando：'].length - [...head].length - [...tail].length;
  const chars = [...String(why)];
  const whyText = chars.length <= budget ? String(why) : chars.slice(0, Math.max(budget - 1, 0)).join('') + '。';
  return `plando：${head}${whyText}${tail}`;
}

// 深拷贝；调用方传入的 state 必须原样不动。
function clone(state) {
  return structuredClone(state);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function cardsOf(state) {
  return Array.isArray(state.cards) ? state.cards : [];
}

// 找到卡片下标；找不到返回 -1。
function indexOfCard(state, id) {
  const cards = cardsOf(state);
  return cards.findIndex((c) => c && c.id === id);
}

/** 下一个可用卡 id：接在已有 cN 之后，避免并发补卡时撞号。 */
function nextCardId(cards) {
  let max = 0;
  for (const card of cards) {
    const m = /^c(\d+)$/.exec(String((card && card.id) || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

/**
 * createCards(state, defs) -> { ok, state?, reason? }
 * defs = [{ techIds: string[], title: string }]，id 依次分配 c1、c2…，status 初始 todo。
 */
export function createCards(state, defs) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法拆卡', '先调 plando_project action=open 读回项目状态') };
  }
  if (!Array.isArray(defs) || defs.length === 0) {
    return { ok: false, reason: reason('cards 不能为空，至少拆一张卡', '按 TECH 项拆出至少一张卡后重传 choose_build') };
  }
  const next = clone(state);
  if (!Array.isArray(next.cards)) next.cards = [];
  const added = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const n = i + 1;
    if (!isPlainObject(def)) {
      return { ok: false, reason: reason(`第 ${n} 张卡不是对象`, '每张卡按 { techIds: string[], title: string } 的形状重传') };
    }
    if (!isNonEmptyString(def.title)) {
      return { ok: false, reason: reason(`第 ${n} 张卡缺少标题`, '给这张卡补上 title 后重传') };
    }
    if (!Array.isArray(def.techIds) || def.techIds.some((id) => !isNonEmptyString(id))) {
      return { ok: false, reason: reason(`第 ${n} 张卡的 techIds 必须是字符串数组`, '把 techIds 改成 TECH 项 id 数组（如 ["t1"]）后重传') };
    }
    added.push({
      id: nextCardId([...next.cards, ...added]),
      techIds: [...def.techIds],
      title: def.title,
      status: 'todo',
      learn: null,
      do: null,
      verify: null,
      evidence: null,
      startedAt: null,
      doneAt: null,
    });
  }
  next.cards = [...next.cards, ...added];
  return { ok: true, state: next };
}

/**
 * startCard(state, id) -> { ok, state?, reason? }
 * 只允许 todo|stale → doing，并写 startedAt。
 */
export function startCard(state, id) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法开工', '先调 plando_project action=open 读回项目状态') };
  }
  const idx = indexOfCard(state, id);
  if (idx < 0) {
    return { ok: false, reason: reason(`没有这张卡（${String(id)}）`, '用 plando_card 传真实存在的卡 id（如 c1）') };
  }
  const next = clone(state);
  const card = next.cards[idx];
  if (!STARTABLE.includes(card.status)) {
    return { ok: false, reason: reason(`卡片 ${card.id} 现在是 ${card.status}，不能重新开工`, '已 done 的卡不用重开；状态不对时先看 plando_status 的卡片清单') };
  }
  card.status = 'doing';
  card.startedAt = nowIso();
  return { ok: true, state: next };
}

/** setLearn(state, id, note)：记录「这张卡学会了什么」。 */
export function setLearn(state, id, note) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法写 learn', '先调 plando_project action=open 读回项目状态') };
  }
  const idx = indexOfCard(state, id);
  if (idx < 0) {
    return { ok: false, reason: reason(`没有这张卡（${String(id)}）`, '用 plando_card 传真实存在的卡 id（如 c1）') };
  }
  if (!isNonEmptyString(note)) {
    return { ok: false, reason: reason('learn 的 note 不能为空', '用一句话写下这张卡你学会了什么后重传') };
  }
  const next = clone(state);
  const card = next.cards[idx];
  card.learn = { note, at: nowIso() };
  // 只写笔记，不隐式改 status：卡片状态只能由 startCard / doneCard / downgradeCard 迁移。
  return { ok: true, state: next };
}

/** setDo(state, id, files)：记录「这张卡改了哪些文件」。 */
export function setDo(state, id, files) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法写 do', '先调 plando_project action=open 读回项目状态') };
  }
  const idx = indexOfCard(state, id);
  if (idx < 0) {
    return { ok: false, reason: reason(`没有这张卡（${String(id)}）`, '用 plando_card 传真实存在的卡 id（如 c1）') };
  }
  if (!Array.isArray(files) || files.some((f) => !isNonEmptyString(f))) {
    return { ok: false, reason: reason('do 的 files 必须是字符串数组', '把本次改动的文件路径填成数组（如 ["src/app.js"]）后重传') };
  }
  const next = clone(state);
  const card = next.cards[idx];
  card.do = { files: [...files], at: nowIso() };
  return { ok: true, state: next };
}

/**
 * 证据的「可观察性」检查：形状对不代表内容对。
 * `{kind:'check', summary:'我懂了'}` 形状完全合法，但它证明不了任何事（REVIEW-tools M4）。
 * 返回 null 表示通过，否则返回人话理由。
 */
const VAGUE_EVIDENCE = ['我懂了', '懂了', '明白了', '会了', '理解了', '没问题', '好了', '可以了', '完成了', '做完了', '实现了'];
const EVIDENCE_FILLER = ['基本', '差不多', '已经', '都', '全部', '所有', '一切', '搞定', '弄好', '完成', '实现', '的', '了'];

function checkEvidenceObservable(summary) {
  if (typeof summary !== 'string') return null;
  const text = String(summary).trim();
  if ([...text].length < 4) return '证据太短，写清你看到了什么（一条命令的输出、一个文件的变化）';
  if (VAGUE_EVIDENCE.includes(text)) return '「我懂了」不是证据——贴命令输出或文件变化';
  // 去掉标点、空话、填充词后还剩下什么？只剩空串说明整句没有任何可核对的内容。
  let rest = text.replace(/[\s，。、,.!！?？;；:：]/g, '');
  for (const word of [...VAGUE_EVIDENCE, ...EVIDENCE_FILLER]) rest = rest.split(word).join('');
  if (rest.length === 0) return '证据里只有「完成 / 懂了」这类空话，贴一条能核对的内容';
  return null;
}

/**
 * doneCard(state, id, evidence, options) -> { ok, state?, reason? }
 * 必须有证据：evidence.kind ∈ {check, files} 且 summary 非空、且说得出可核对的东西；只允许 doing → done。
 *
 * options.lastCheck：`checks.readLastCheck(dir)` 的结果（可选，由 tools.js 注入）。
 * 传了就要对账：`kind:'check'` 必须真有对应的成功执行记录。这是 M4 的修法——
 * 「跑了 npm test，退出码 0」这句话在从没跑过的时候一样写得出来。
 */
export function doneCard(state, id, evidence, options = {}) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法收尾', '先调 plando_project action=open 读回项目状态') };
  }
  const idx = indexOfCard(state, id);
  if (idx < 0) {
    return { ok: false, reason: reason(`没有这张卡（${String(id)}）`, '用 plando_card 传真实存在的卡 id（如 c1）') };
  }
  const card = cardsOf(state)[idx];
  if (card.status !== 'doing') {
    return {
      ok: false,
      reason: reason(
        `卡片 ${card.id} 现在是 ${card.status}，不能直接 done`,
        card.status === 'stale' ? 'stale 的卡先 start 重做，再收尾' : '先 start 这张卡，做完再 done',
      ),
    };
  }
  if (!isPlainObject(evidence) || !['check', 'files'].includes(evidence.kind) || !isNonEmptyString(evidence.summary)) {
    return { ok: false, reason: reason('done 必须带证据（kind 为 check/files 的 summary）', '先跑 plando_check 或列出改过的文件，把结论作为 evidence.summary 重传') };
  }
  // 形状对不代表内容对：`{kind:'check', summary:'我懂了'}` 也是合法形状（REVIEW-tools M4）。
  const vague = checkEvidenceObservable(evidence.summary);
  if (vague) {
    return { ok: false, reason: reason(vague, '把 plando_check 的输出或具体文件变化写进 evidence.summary 后重传') };
  }
  // 对账：`kind:'check'` 的证据必须有对应的**成功执行记录**（REVIEW-tools M4 的正修法）。
  // 只有在调用方拿到凭据（options 里有 lastCheck 这个键）时才强制——
  // 免得纯函数调用方（测试、将来的批量脚本）被一个文件系统依赖绊住。
  if (evidence.kind === 'check' && Object.prototype.hasOwnProperty.call(options, 'lastCheck')) {
    const last = isPlainObject(options.lastCheck) ? options.lastCheck : null;
    if (!last) {
      return {
        ok: false,
        reason: reason(`卡片 ${card.id} 说跑了检查，但 .plando/ 里没有任何执行记录`, '先真的跑 plando_check action=run，再拿它的输出作为证据'),
      };
    }
    if (last.name !== card.id) {
      return {
        ok: false,
        reason: reason(`最近一次检查是「${last.name}」的，不是这张卡（${card.id}）的`, `用 plando_check action=run name=${card.id} 跑本卡自己的检查`),
      };
    }
    if (last.ok !== true) {
      return {
        ok: false,
        reason: reason(`卡片 ${card.id} 的检查上次没通过（退出码 ${last.exitCode}）`, '看 stderr 修到退出码 0，再跑一次检查后收尾'),
      };
    }
  }
  const next = clone(state);
  const target = next.cards[idx];
  target.status = 'done';
  target.doneAt = nowIso();
  target.evidence = { kind: evidence.kind, summary: evidence.summary, at: nowIso() };
  if (!target.startedAt) target.startedAt = target.doneAt;
  return { ok: true, state: next };
}

/**
 * downgradeCard(state, id, why) -> { ok, state?, reason? }
 * status → downgraded；必须带理由，并写入 state.downgrades 留痕。
 */
export function downgradeCard(state, id, why) {
  if (!isPlainObject(state)) {
    return { ok: false, reason: reason('state 不是对象，无法降级', '先调 plando_project action=open 读回项目状态') };
  }
  const idx = indexOfCard(state, id);
  if (idx < 0) {
    return { ok: false, reason: reason(`没有这张卡（${String(id)}）`, '用 plando_card 传真实存在的卡 id（如 c1）') };
  }
  if (!isNonEmptyString(why)) {
    return { ok: false, reason: reason('downgrade 必须写明理由', '用一句话说明为什么这张卡降级（如「时间不够，改成只跑通 demo」）后重传') };
  }
  const next = clone(state);
  const card = next.cards[idx];
  if (CLOSED.includes(card.status)) {
    return { ok: false, reason: reason(`卡片 ${card.id} 已经是 ${card.status}，不能再降级`, '收尾过的卡不再改动；确有需要先 reopen 项目') };
  }
  card.status = 'downgraded';
  if (!Array.isArray(next.downgrades)) next.downgrades = [];
  // from 记录降级前的状态（此时 card.status 已经是 downgraded，不能直接读它）。
  next.downgrades.push({ cardId: card.id, reason: why, from: cardsOf(state)[idx].status, at: nowIso() });
  return { ok: true, state: next };
}

/**
 * cardProgress(state) -> { total, done, downgraded, doing, todo, stale, current }
 * current 指向正在做的那张卡（没有 doing 时取第一张未收尾的卡），全部收尾则为 null。
 */
export function cardProgress(state) {
  const cards = cardsOf(isPlainObject(state) ? state : {});
  const count = (status) => cards.filter((c) => c && c.status === status).length;
  const doing = cards.find((c) => c && c.status === 'doing');
  const open = cards.find((c) => c && !CLOSED.includes(c.status));
  const current = doing ? doing.id : open ? open.id : null;
  return {
    total: cards.length,
    done: count('done'),
    downgraded: count('downgraded'),
    doing: count('doing'),
    todo: count('todo'),
    stale: count('stale'),
    current: current || null,
  };
}
