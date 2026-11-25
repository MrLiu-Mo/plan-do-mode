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
 * 降级话术：这些词删掉之后如果什么都不剩，说明整句只是在表达「不想做了」。
 *
 * 为什么这里必须有一份词表（而 R5/R6 的结论是「别再加名单」）：
 * 那两条的名单是**枚举攻击面**（开关名、包名），攻击者能无限造新名字，所以结构化剥壳才对；
 * 这里的词表是**枚举自然语言里的空话**，模型的措辞是收敛的常用说法，词表能覆盖。
 * 但词表只做「删除」不做「判决」——真正的判据是「删完还剩多少实质内容」，
 * 所以新造一句空话最多让它多写几个字，不会像黑名单那样一绕就过。
 */
const DOWNGRADE_VAGUE = [
  '随便', '算了', '太难', '太复杂', '不想做', '放弃', '先放着', '以后再说', '下次补',
  '没时间', '时间不够', '先这样', '搞不定', '略过', '跳过', '够用', '不做了', '做不下去',
  '做不出来', '卡住', '有困难', '能力不行', '水平不够', '暂时', '反正', '无所谓',
  '更要紧', '忙不过来', '精力有限', '状态不好', '心情不好', '想休息', '凑合', '就这样',
  '别的', '先略过', '不重要', '不用做', '不需要', '没空', '没精力',
  // §16 R11 复查补的 7 个：都是「把事往后推」而不是「交付到哪」，同样零对象。
  // 这不是在给攻击面打补丁（那类名单永远补不完），而是在收「口语里表达『算了』的常用说法」——
  // 它收敛，所以能列；判决权仍然在「删完还剩多少实质内容」那条规则手里。
  '懒得', '下次', '明天', '再说', '先做', '先看', '攒',
];

/**
 * 降级理由的「具体性」检查（REVIEW-tools §14 R7 / §16 R11）。
 *
 * 原来这里复用 `checkEvidenceObservable`，实测判别力约等于「≥4 个字」：
 * 36 条空话里放过 28 条（`'时间不够'` 也过）。原因是它只认「整句是不是纯空话」，
 * 而 `'时间不够'` 里有「时间」「不够」这些不在表里的词，于是被当成有内容。
 *
 * 判据：删掉空话词与填充词、去掉标点之后，**要么还剩 ≥6 个实质字符，要么出现可指认的标记**
 * （带扩展名的文件名 / ≥3 字母的拉丁词）。两条都满足不了就是空话。
 *
 * §16 R11 复查发现「**光有一个数字**也算标记」是这个判据的旁路：
 * `'算了，明天再说 1'` / `'太难了，先做别的 2'` / `'随便吧，凑合能用 1'` 十句十过——
 * 空话后面随便缀个数字就能收卡。所以**数字不再单独算标记**：
 * 「第 1 步」「第 2 版」说的是进度，不是「交付了什么」，而判据要的正是后者。
 * 数字仍然留在 `rest` 里参与字数（`'做到第 1 步的录入'` 够 6 字，照过）。
 *
 * 试过但**弃掉**的方案：「有逗号就算分成两段」（「A 做不了，B 先顶着」）——
 * 实测被 `'随便吧，不做了'` / `'算了，跳过'` 这类一条不落地绕开（8/8 漏放）；
 * 逗号只证明句子被切开了，不证明句子里有对象。
 * 另一个弃掉的方案：只抬字数门槛——空话可以靠重复刷够字数。
 *
 * 代价（**故意的**）：`'时间不够'` 会被拒，因为它没说交付了什么。
 * 拒绝理由里会直接教怎么补（「时间不够，只跑通 demo」），所以这不是死路。
 * 返回 null 表示通过，否则返回人话理由。
 */
function checkDowngradeReason(why) {
  const vague = checkEvidenceObservable(why);
  if (vague) return vague;
  const text = String(why).trim();
  const hasMarker = /[\w-]+\.[A-Za-z]{1,5}\b/.test(text) // 文件名：app.js / .env
    || /[A-Za-z]{3,}/.test(text); // 拉丁词：demo / API / csv
  if (hasMarker) return null;

  // 删掉空话、填充词、标点，看还剩多少真东西。
  let rest = text.replace(/[\s，。、,.!！?？;；:：]/g, '');
  for (const word of [...DOWNGRADE_VAGUE, ...VAGUE_EVIDENCE, ...EVIDENCE_FILLER]) {
    rest = rest.split(word).join('');
  }
  if ([...rest].length < 6) {
    return '理由里没有可指认的对象——写清「降级后实际交付到哪一步」（如「时间不够，只跑通 demo」）';
  }
  return null;
}

/**
 * 项目现有文件清单归一化：小写 + 只留相对路径的 `/` 形式，方便与证据里的文件名比对。
 * 入参来自工具层（扫盘结果），纯函数不读盘。
 *
 * 模式产物在这里再排一次：工具层已经排过了，但纯函数不该假设调用方一定排过——
 * 拿 `IDEA.md` / `TECH.md` 当「我做的文件」是**自证**（它们由插件自己渲染），
 * 这条守在本文件里才不会被将来的新调用方绕开（REVIEW-tools §16 R10）。
 */
const SELF_RENDERED = ['idea.md', 'tech.md', 'verify.md', 'handoff.md', 'change-guide.md'];

function normalizeProjectFiles(files) {
  const set = new Set();
  for (const entry of Array.isArray(files) ? files : []) {
    if (!isNonEmptyString(entry)) continue;
    const normalized = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!normalized) continue;
    const base = normalized.split('/').pop();
    if (SELF_RENDERED.includes(base)) continue; // 插件自己渲染的产物，不能当证据
    // 同时收「完整相对路径」和「basename」：证据里常只写文件名不写目录。
    set.add(normalized);
    set.add(base);
  }
  return set;
}

/**
 * 从证据里抠出「它声称改动过的文件」：带扩展名的 token。
 * 认 `app.js` / `src/app.js` / `.env` / `index.html`，不认纯单词。
 */
function claimedFiles(summary, card) {
  const text = String(summary || '');
  const found = new Set([...text.matchAll(/[\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b/g)].map((m) => m[0]));
  // 卡片的 do.files 也算「点名」：模型可能把文件名写在 do 里、summary 只写结论。
  for (const file of Array.isArray(card && card.do && card.do.files) ? card.do.files : []) {
    if (isNonEmptyString(file)) found.add(String(file));
  }
  return [...found].map((name) => name.replace(/\\/g, '/').replace(/^\.\//, ''));
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
  // 对账①：`kind:'check'` 的证据必须有对应的**成功执行记录**（REVIEW-tools M4 的正修法）。
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
  // 对账②：`kind:'files'` 的证据要点名**真实存在的文件**（REVIEW-tools §14 R7）。
  //
  // M4 只对账了 check 分支；files 分支此前零文件系统访问，于是
  // `summary:'创建了完全不存在-abc123.py'` 照样能过——「1 张 done + N 张降级」
  // 就成了一条零产出到 done 的短路。这里由工具层注入项目现有文件清单，
  // 要求证据里至少点名一个**真的在项目里**的文件。
  // 纯函数调用方不传 projectFiles 时不强制（同 lastCheck 的约定）。
  //
  // 注意这份清单**不含**脚手架能写的 7 个配置文件与模式产物（`listProjectFiles` 里排掉了）：
  // §16 R10 报的就是「scaffold 写 package.json → do.files 点它 → done」这条自我认证的路。
  const businessFiles = Object.prototype.hasOwnProperty.call(options, 'projectFiles')
    ? normalizeProjectFiles(options.projectFiles)
    : null;
  // 对账③：**项目里至少要有一个用户自己的产出**（REVIEW-tools §16 R12）。
  //
  // 这是「零产出也能到 done」三条路里最便宜的一条：`node --test` 在一个测试文件都没有的项目里
  // 退出码是 **0**，而 M4 的判据就是「退出码是不是 0」。于是
  // `declare node --test → run(通过) → done` 三步就能把卡收掉，AI 一个字都没写。
  // 判据不看「跑没跑」，看「有没有东西被做出来」——业务文件数为 0 时，任何证据都不成立。
  if (businessFiles && businessFiles.size === 0) {
    return {
      ok: false,
      reason: reason(
        `卡片 ${card.id} 想收尾，但项目里还没有你自己的文件（只有模式产物/配置文件）`,
        '先做出一个真实的业务文件（哪怕是一个最小的 index.html 或 test/x.test.js），再收尾',
      ),
    };
  }
  if (evidence.kind === 'files' && businessFiles) {
    const listed = businessFiles;
    const claimed = claimedFiles(evidence.summary, card);
    const hit = claimed.find((name) => listed.has(name.toLowerCase()));
    if (!hit) {
      const sample = claimed.slice(0, 2).join('、') || '（证据里没点到任何文件名）';
      return {
        ok: false,
        reason: reason(
          `卡片 ${card.id} 的文件证据在项目里找不到：${sample}`,
          '改完真跑一次（或看一眼确实生成的文件），把真实存在的文件名写进 evidence.summary 后重传',
        ),
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
  // 理由也要能核对（REVIEW-tools §12 R3 / §14 R7）：`'x'` / `'我懂了'` 写进去等于没写，
  // 而 `'时间不够'` 这种「听着像理由但没有具体对象」的也要拦——它说不出降级后交付了什么。
  const vague = checkDowngradeReason(why);
  if (vague) {
    return { ok: false, reason: reason(`downgrade 的理由不算理由：${vague}`, '写清降级后**实际交付到哪一步**（如「只跑通 demo，保存功能没做」）后重传') };
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
