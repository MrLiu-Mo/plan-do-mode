// lib/tools.js —— 8 个 plando_* 工具（手工拼 ToolDefinition 纯对象，不用 defineTool）。
//
// 硬约束（docs/API-FACTS.md §2/§4）：
//   - 零依赖：本文件只 import node: 内置模块；其余模块一律从 deps 注入（INTERFACES §4）。
//   - definition 是纯对象，parameters 是手写 JSON Schema，output 是 { schema, render }。
//   - execute 返回字符串，**永不抛异常**：所有异常在 run() 里统一转成
//     `plando：…——下一步：…` 文本（CONTRACT §5）。
//
// 依赖方向（INTERFACES §1）：index.js → tools.js → 各纯函数模块。tools.js 不认识 ctx，
// 只认识 deps；把 ctx 只用在 registerTools() 里注册。

import path from 'node:path';
import fs from 'node:fs';

/** 8 个工具名，顺序照 PLAN.md §4 的工具表。测试会逐项断言。 */
export const TOOL_NAMES = [
  'plando_status',
  'plando_project',
  'plando_idea',
  'plando_clarify',
  'plando_transition',
  'plando_card',
  'plando_check',
  'plando_scaffold',
];

/** 所有工具的输出都是一段纯文本。 */
const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
});

const ARTIFACT_FILES = ['IDEA.md', 'TECH.md', 'VERIFY.md', 'HANDOFF.md', 'CHANGE-GUIDE.md'];

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 把一条已经是 plando 形状的文本压到 160 字以内，保住结尾的「——下一步：…」。
 * 下层模块（project.js 读盘、checks.js 执行）会把这些路径拼进 reason，路径一长就超限；
 * CONTRACT §5 是硬约束，所有出口都要守（REVIEW-tools M3）。
 */
function clampReason(message) {
  const text = String(message ?? '');
  const chars = [...text];
  if (chars.length <= 160) return text;
  const sepIndex = text.indexOf('——下一步：');
  if (sepIndex < 0) return `${chars.slice(0, 159).join('')}。`;
  const tailChars = [...text.slice(sepIndex)];
  const tail = tailChars.length <= 61 ? tailChars.join('') : `${tailChars.slice(0, 60).join('')}。`;
  const budget = Math.max(160 - [...tail].length - 1, 0);
  const headChars = [...text.slice(0, sepIndex)];
  const head = headChars.length <= budget ? headChars.join('') : `${headChars.slice(0, budget).join('')}。`;
  return head + tail;
}

/** 统一错误文本：`plando：<为什么>——下一步：<做什么>`（CONTRACT §5）。 */
function errText(why, next) {
  const whyText = String(why || '这条路走不通').trim();
  const nextText = String(next || '先调 plando_status 看下一步，再重试').trim();
  const head = 'plando：';
  const tail = `——下一步：${nextText}`;
  const budget = 160 - [...head].length - [...tail].length;
  const chars = [...whyText];
  const body = chars.length <= budget ? whyText : `${chars.slice(0, Math.max(budget - 1, 0)).join('')}。`;
  return clampReason(`${head}${body}${tail}`);
}

/**
 * 抛一条已经是 plando 形状的错误；run() 会原样透传。
 * 若 why 已经是完整形状（下层模块如 state.js / cards.js / scaffold.js 返回的 reason
 * 都自带 `plando：…——下一步：…`），就**原样抛**，不再包第二层——
 * 否则会出现 `plando：plando：…——下一步：…——下一步：…`，模型会照着两个不同的下一步乱走。
 * 但要过一遍 clampReason：透传不等于免检长度。
 */
function fail(why, next) {
  const text = String(why ?? '').trim();
  if (text.startsWith('plando：')) throw new Error(clampReason(text));
  throw new Error(errText(text, next));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 单轮澄清答案的字节上限。state.json 读取上限是 2 MB（project.js MAX_JSON_BYTES），
 * 而一个项目会累积数十条答案 + 技术项 + 卡片——单条答案给 32 KB 已经很宽松了。
 */
const MAX_ANSWER_BYTES = 32 * 1024;

/** 模型有时把 JSON 当字符串塞进对象参数，这里顺手解一次（API-FACTS §2）。 */
function normalizeObject(raw) {
  if (isPlainObject(raw)) return { ...raw };
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // 不是合法 JSON 就当没传，由后续校验拒绝
    }
  }
  return {};
}

/** 取必填字符串参数，缺了就抛人话错误。 */
function requireString(input, name, next) {
  const value = input[name];
  if (!isNonEmptyString(value)) fail(`缺少必填参数 ${name}`, next || `补上 ${name} 后重试`);
  return value.trim();
}

/** 统一 execute 包装：参数形状不对、body 抛错，都转成字符串，绝不把异常抛给模型。 */
async function run(args, body, deps, toolName) {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    const bad = errText('参数必须是一个对象', '按工具的参数说明传 { ... } 后重试');
    logRejection(deps, bad, toolName, args);
    return bad;
  }
  const input = args || {};
  try {
    return String(await body(input));
  } catch (error) {
    const message = String((error && error.message) || error || '未知错误');
    if (message.startsWith('plando：')) {
      logRejection(deps, message, toolName, input);
      return message;
    }
    const wrapped = errText(message, '先调 plando_status 确认阶段与项目路径，再按参数说明重试');
    logRejection(deps, wrapped, toolName, input);
    return wrapped;
  }
}

/**
 * 把被拒绝的调用记进 log.jsonl。
 *
 * 原来只有 plando_transition 的失败会留痕，别的工具被拒一律不写日志——
 * 于是「用户在 build 阶段试了 10 次 scaffold 都被拒」这件事在 .plando/log.jsonl 里完全看不到，
 * 事后没法复盘模型为什么卡住（REVIEW-tools M2）。
 *
 * 记的内容必须能回答「是谁、在哪个项目、为什么被拒」（REVIEW-tools §9.4 N16）：
 * 只有 `source:'tool'` 的话，多项目 / 多工具时这行日志等于没写。
 */
function logRejection(deps, message, toolName, input) {
  try {
    // 优先用这次调用自己带的 dir（它是准确的），没有再退回守卫记下的活跃项目。
    const explicit = input && isNonEmptyString(input.dir) ? input.dir.trim() : '';
    const fallback = deps && deps.runtime && isNonEmptyString(deps.runtime.activeProjectDir) ? deps.runtime.activeProjectDir : '';
    const dir = explicit || fallback;
    if (!dir) return;
    appendLog(dir, deps, {
      kind: 'reject',
      source: 'tool',
      tool: isNonEmptyString(toolName) ? toolName : 'unknown',
      dir: path.resolve(dir),
      reason: clampReason(String(message)),
    });
  } catch {
    // 记日志失败不该影响工具返回
  }
}

/** 记下「当前活跃项目」给守卫定位状态文件用（只记路径，不记状态）。 */
function noteActiveDir(dir, deps) {
  if (deps.runtime && typeof deps.runtime === 'object' && isNonEmptyString(dir)) {
    deps.runtime.activeProjectDir = path.resolve(dir);
  }
}

/**
 * 项目目录：args.dir 优先，其次配置里的 defaultProjectDir。顺便记下「当前活跃项目」给守卫用。
 *
 * 显式传的 dir **必须是绝对路径**：相对路径会相对进程 CWD 解析，而 CWD 不受项目控制，
 * 一句 `plando_status {dir:'..'}` 就能把守卫的观察点挪到别的目录（REVIEW-tools G4）。
 */
function resolveDir(input, deps) {
  const raw = isNonEmptyString(input.dir) ? input.dir.trim() : '';
  if (raw !== '' && !path.isAbsolute(raw)) {
    fail(`dir 必须是绝对路径（收到「${raw}」）`, '传项目根目录的完整路径，如 D:\\work\\my-app');
  }
  const picked = raw !== '' ? raw : deps.config && deps.config.defaultProjectDir;
  if (!isNonEmptyString(picked)) {
    fail('不知道在哪个项目里', '传 dir（项目绝对路径），或在插件配置里设 defaultProjectDir');
  }
  if (raw === '' && !path.isAbsolute(picked)) {
    fail('配置里的 defaultProjectDir 不是绝对路径', '在插件配置里把它改成绝对路径（如 D:\\work\\my-app）');
  }
  const dir = path.resolve(picked);
  // 只记路径、不记状态：守卫每次仍会重新读盘（INTERFACES §5）。
  // 而且**只记真的读过状态的项目**——随手传一个不存在的 dir 不该把守卫的观察点挪走
  // （REVIEW-tools G4：一次失败的调用就能让守卫看别处）。
  if (fs.existsSync(path.join(dir, '.plando', 'state.json'))) noteActiveDir(dir, deps);
  return dir;
}

/** 读项目状态；读不出来直接抛 plando 形状错误（恢复指引由 format.formatRecover 负责的场景除外）。 */
function loadOrFail(dir, deps) {
  const loaded = deps.project.loadState(dir);
  if (!loaded.ok) fail(loaded.reason, '先 plando_project action=open 打开项目；状态损坏时人工修回，不要重置');
  return loaded.state;
}

/** 追加一行 log.jsonl（每次推进/拒绝/降级留痕）。写日志失败不影响主流程。 */
function appendLog(dir, deps, entry) {
  try {
    const paths = deps.project.projectPaths(dir);
    fs.mkdirSync(paths.plandoDir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(paths.logPath, `${line}\n`, 'utf8');
  } catch {
    // 日志是辅助留痕，写不进去不该让工具失败
  }
}

/**
 * 写一个文本文件（自动建父目录），返回相对路径（统一用 /，Windows 上也好看）。
 * 落盘前必须确认目标仍在项目目录内：卡片 id 之类的名字来自模型 payload，
 * 未净化时 `path.join` 会被 `../` 带出项目目录，覆盖任意文件（REVIEW-state F5）。
 */
function writeText(dir, rel, content) {
  const root = path.resolve(dir);
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error (`plando：产物路径「${rel}」跑到项目目录外了——下一步：检查里头的 id / 文件名有没有 ../ 或盘符`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return rel.split(path.sep).join('/');
}

/** 已存在的产物文件名清单（plando_status 用）。 */
function existingArtifacts(dir) {
  const root = path.resolve(dir);
  const found = ARTIFACT_FILES.filter((rel) => fs.existsSync(path.join(root, rel)));
  if (fs.existsSync(path.join(root, '.plando'))) found.push('.plando/');
  return found;
}

/** 可选的自动提交：config.autoCommit 打开时只提交模式产物（PLAN §7）。 */
function autoCommit(dir, deps, message) {
  if (!deps.config || deps.config.autoCommit !== true) return null;
  try {
    return deps.git.commitArtifacts(dir, message);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 工具定义（每个工具一个函数；execute 统一走 run()）
// ---------------------------------------------------------------------------

/**
 * 成功消息里的路径：太长的只显示尾部两段（`…\bbb\ccc`）。
 * 契约 §5 的 160 字只约束错误消息，但一条 420 字的首行在终端里要折三行（REVIEW-tools §9.4 N17）。
 * 完整路径仍可以从 plando_status 看到。
 */
function shortPath(dir) {
  const text = String(dir || '');
  if ([...text].length <= 60) return text;
  const parts = text.split(/[\\/]/).filter(Boolean);
  return `…${path.sep}${parts.slice(-2).join(path.sep)}`;
}

function projectTool(deps) {
  return {
    name: 'plando_project',
    description:
      '项目入口：action=open 打开已有项目（读回 .plando/state.json），action=list 列出灵感库里登记过的项目，action=init 新建项目并写入初始状态。状态损坏时只报错不重置；接手一个已有目录先 open，不要重复 init。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'list', 'init'], description: '要做什么：open 打开 / list 列出 / init 新建。' },
        dir: { type: 'string', description: '项目绝对路径。open 与 init 必填；省略时退回配置里的 defaultProjectDir。' },
        name: { type: 'string', description: 'init 时的项目名；省略用目录名。' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const action = requireString(input, 'action', '传 action=open / list / init');
        if (action === 'list') {
          const rows = deps.project.listProjects(deps.config.dataRoot);
          return deps.format.formatProjectList(rows);
        }
        if (action === 'init') {
          const dir = resolveDir(input, deps);
          const budget = deps.config.budget;
          const name = isNonEmptyString(input.name) ? input.name.trim() : path.basename(dir);
          const created = deps.project.initProject(dir, { name, budget, dataRoot: deps.config.dataRoot });
          if (!created.ok) fail(created.reason, '用 plando_project action=open 打开已有项目，或换一个空目录 init');
          // init 之前 .plando/state.json 还不存在，resolveDir 不会记活跃目录，这里补上。
          noteActiveDir(dir, deps);
          appendLog(dir, deps, { kind: 'project', action: 'init', name });
          autoCommit(dir, deps, `plando(init): 立项 ${name}`);
          return `已立项：${created.state.name}（${shortPath(dir)}）\n项目 id：${created.state.projectId}\n现在在「澄清」阶段。\n下一步：用 plando_clarify record 记录第一轮的问答，或直接 plando_transition 传 clarify_done。`;
        }
        if (action === 'open') {
          const dir = resolveDir(input, deps);
          const opened = deps.project.openProject(dir);
          if (!opened.ok) fail(opened.reason, '确认目录里已有 .plando/state.json；没有就先 plando_project action=init 立项');
          const state = opened.state;
          const migrated = opened.migrated ? '\n注意：读到的旧版状态已迁移到当前版本并写回。' : '';
          return `已打开：${state.name}（${state.stage}）${migrated}\n下一步：${deps.state.NEXT_ACTIONS[state.stage] || '先 plando_status 看现状'}`;
        }
        fail(`不认识的 action：${action}`, '只支持 open / list / init');
      }, deps, 'plando_project');
    },
  };
}

/** 生成不撞号的灵感 id：`idea_<base36 时间>_<序号>`（REVIEW-tools L3：同毫秒内原来必撞）。 */
function nextIdeaId(ideas) {
  const list = Array.isArray(ideas) ? ideas : [];
  const base = `idea_${Date.now().toString(36)}`;
  if (!list.some((idea) => idea && idea.id === base)) return base;
  let n = 2;
  while (list.some((idea) => idea && idea.id === `${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function ideaTool(deps) {
  return {
    name: 'plando_idea',
    description:
      '灵感库：action=add 记一条想法，action=list 看全部，action=pick 把一条想法立项成项目（要过三问：还想做/现在做/一个人做得完，并给 dir），action=park 标「以后再说」，action=drop 删掉未立项的想法。用户说「我有个想法」时用 add；想开新项目用 pick。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'pick', 'park', 'drop'], description: '灵感库操作。' },
        title: { type: 'string', description: 'add 时的想法一句话描述。' },
        id: { type: 'string', description: 'pick / park / drop 时的灵感 id。' },
        dir: { type: 'string', description: 'pick 时必填：立项到的项目绝对路径。' },
        answers: {
          description: 'pick 时的三问答案，形如 { want: true, now: true, solo: true }；三项都为 true 才允许立项。',
        },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const action = requireString(input, 'action', '传 action=add / list / pick / park / drop');
        const dataRoot = deps.config.dataRoot;
        const ideas = deps.project.readIdeas(dataRoot);
        if (action === 'list') return deps.format.formatIdeaList(ideas);
        if (action === 'add') {
          const title = requireString(input, 'title', '用一句话写清这个想法，再 action=add');
          const entry = { id: nextIdeaId(ideas), title, at: new Date().toISOString(), parked: false, picked: null };
          deps.project.writeIdeas(dataRoot, [...ideas, entry]);
          return `已记下（${entry.id}）：${title}\n下一步：想推进它就 plando_idea action=pick（要过三问 + 给 dir）。`;
        }
        const id = requireString(input, 'id', '先 plando_idea action=list 拿到灵感 id');
        const index = ideas.findIndex((item) => item && item.id === id);
        if (index < 0) fail(`灵感库里没有 ${id}`, '用 plando_idea action=list 看真实 id');
        if (action === 'park') {
          const next = ideas.map((item, i) => (i === index ? { ...item, parked: true } : item));
          deps.project.writeIdeas(dataRoot, next);
          return `已标「以后再说」：${ideas[index].title}`;
        }
        if (action === 'drop') {
          if (ideas[index].picked) fail(`灵感 ${id} 已经立项，不能从灵感库删除`, '已立项的项目用 plando_transition event=drop 放弃');
          deps.project.writeIdeas(dataRoot, ideas.filter((_, i) => i !== index));
          return `已删除：${ideas[index].title}`;
        }
        if (action === 'pick') {
          const answers = normalizeObject(input.answers);
          const three = ['want', 'now', 'solo'];
          const missing = three.filter((key) => answers[key] !== true);
          if (missing.length > 0) {
            fail(`立项三问还没全过（缺 ${missing.join('、')}）`, '先和用户确认「还想做 / 现在做 / 一个人做得完」都成立，再传 answers={want:true,now:true,solo:true}');
          }
          const dir = requireString(input, 'dir', 'pick 必须给 dir（新项目落在哪个绝对路径）');
          noteActiveDir(dir, deps);
          const created = deps.project.initProject(dir, {
            name: ideas[index].title,
            budget: deps.config.budget,
            dataRoot,
          });
          if (!created.ok) fail(created.reason, '换一个空目录，或先 plando_project action=open 打开已有项目');
          const next = ideas.map((item, i) => (i === index ? { ...item, picked: created.state.projectId } : item));
          deps.project.writeIdeas(dataRoot, next);
          appendLog(dir, deps, { kind: 'project', action: 'pick', ideaId: id });
          autoCommit(dir, deps, `plando(pick): 立项 ${ideas[index].title}`);
          return `已立项：${created.state.name} → ${path.resolve(dir)}\n现在在「澄清」阶段。\n下一步：用 plando_clarify record 或 plando_transition 传 clarify_done 把「做成什么样」定下来。`;
        }
        fail(`不认识的 action：${action}`, '只支持 add / list / pick / park / drop');
      }, deps, 'plando_idea');
    },
  };
}

/**
 * 作废版 VERIFY.md：revise / reopen 把 verify 清空后，磁盘上那份旧假设要显式作废，
 * 而不是留着让人以为「已经验证过」（REVIEW-state R5）。
 */
function renderRetiredVerify(state) {
  const reason = isNonEmptyString(state.reviseReason) ? state.reviseReason : '项目重新开始，上一轮验证作废';
  return [
    `# ${state.name || '未命名项目'} 验证记录（已作废）`,
    '',
    '> 上一轮的验证结论已随需求变更失效，下面不再保留旧假设。',
    '> 重新验证请用 plando_transition 传 choose_verify。',
    '',
    '## 作废原因',
    '',
    `- ${reason}`,
    '',
  ].join('\n');
}

/**
 * 重渲染产物并落盘（transition / card 成功后都走这里）。只写与该 state 相关的文件。
 *
 * 分两步：先**在内存里**把所有产物渲染出来（纯函数，失败就抛，此时还没动磁盘），
 * 再统一写文件。这样渲染失败不会留下「state 已推进、产物没更新、日志也没记」的半截状态
 * （REVIEW-tools M1）。
 */
function renderArtifacts(dir, state, deps) {
  const papers = deps.artifacts;
  const planned = [];
  if (isPlainObject(state.idea)) {
    planned.push(['IDEA.md', papers.renderIdea(state)]);
  }
  const items = (state.tech && Array.isArray(state.tech.items)) ? state.tech.items : [];
  if (items.length > 0) planned.push(['TECH.md', papers.renderTech(state)]);
  const hasVerify = isPlainObject(state.verify) && isNonEmptyString(state.verify.hypothesis);
  if (hasVerify) planned.push(['VERIFY.md', papers.renderVerify(state)]);
  // 旧验证被清掉（revise / reopen）后，磁盘上的 VERIFY.md 不能留着上一版假设：
  // 模型会以为「已经验证过」。这里改写成一则作废说明，既不丢内容也不误导（REVIEW-state R5）。
  else if (fs.existsSync(path.join(path.resolve(dir), 'VERIFY.md'))) {
    planned.push(['VERIFY.md', renderRetiredVerify(state)]);
  }
  if (state.terminal && state.terminal.kind === 'handoff') {
    planned.push(['HANDOFF.md', papers.renderHandoff(state)]);
  }
  if (isNonEmptyString(state.reviseReason) || (state.idea && isNonEmptyString(state.idea.changeReason))) {
    planned.push(['CHANGE-GUIDE.md', papers.renderChangeGuide(state)]);
  }
  const cards = Array.isArray(state.cards) ? state.cards : [];
  for (const card of cards) {
    if (!card || !isNonEmptyString(card.id)) continue;
    const rel = path.join('.plando', 'cards', `${card.id}.md`);
    planned.push([rel, papers.renderCard(state, card)]);
  }

  const written = [];
  for (const [rel, content] of planned) written.push(writeText(dir, rel, content));
  return written;
}

// 统一「推进成功后」的收尾：**先渲染**产物 → 再落盘 state → 追加日志 → 可选自动提交。
// 顺序很重要：渲染在内存里做，失败时还没动磁盘，state 不会「已推进但产物没更新」（REVIEW-tools M1）。
function afterTransition(dir, state, event, deps, extra = {}) {
  const rendered = renderArtifacts(dir, state, deps);
  const saved = deps.project.saveState(dir, state);
  appendLog(dir, deps, { kind: 'transition', event, from: extra.from, to: saved.stage, files: rendered });
  const commit = autoCommit(dir, deps, `plando(${saved.stage}): ${event}`);
  return { state: saved, files: rendered, commit };
}

function clarifyTool(deps) {
  return {
    name: 'plando_clarify',
    description:
      '澄清阶段：action=record 记录一轮问答（kind=detail 记「做成什么样」的细节，kind=baseline 记用户基线：经验/每周小时/目标），action=list 看已记录的问答与未解问题。一次只问不超过 3 个问题，总共不超过 2 轮；记录够七个字段后用 plando_transition 传 clarify_done。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'list'], description: 'record 记录一轮 / list 查看已记录内容。' },
        kind: { type: 'string', enum: ['detail', 'baseline'], description: 'record 时必填：detail 记细节，baseline 记用户基线。' },
        dir: { type: 'string', description: '项目绝对路径；省略用 defaultProjectDir。' },
        questions: {
          type: 'array',
          items: { type: 'string' },
          description: 'record 时：这一轮问了哪几个问题（最多 3 个）。',
        },
        answers: {
          description: 'record 时：本轮答案，形如 { what: "...", done: "...", notDo: "..." } 或 { experience, hoursPerWeek, goal }。',
        },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const action = requireString(input, 'action', '传 action=record 或 list');
        const dir = resolveDir(input, deps);
        const state = loadOrFail(dir, deps);
        if (action === 'list') {
          const clarify = state.clarify || {};
          const answers = Array.isArray(clarify.answers) ? clarify.answers : [];
          const open = Array.isArray(clarify.open) ? clarify.open : [];
          const lines = [`澄清轮次：${clarify.rounds || 0} / 2`];
          if (answers.length === 0) lines.push('还没有记录。下一步：plando_clarify action=record 问清「做成什么样」并记下来。');
          for (const item of answers) lines.push(`· ${JSON.stringify(item)}`);
          if (open.length > 0) lines.push(`未解问题：${open.join('；')}`);
          return lines.join('\n');
        }
        if (action !== 'record') fail(`不认识的 action：${action}`, '只支持 record / list');
        // 阶段闸门：record 只在 clarify 阶段有意义（list 任何阶段都能看）。
        if (state.stage !== 'clarify') {
          fail(
            `现在是「${deps.state.STAGE_LABELS[state.stage] || state.stage}」阶段，不需要继续澄清`,
            `先用 plando_status 看下一步；要回澄清请按 CONTRACT §2 的事件表推进`,
          );
        }

        const kind = requireString(input, 'kind', 'record 时传 kind=detail 或 baseline');
        const answers = normalizeObject(input.answers);
        if (Object.keys(answers).length === 0) fail('answers 是空的，没有可记录的内容', '把本轮问答整理成对象后重传');
        // 澄清答案会被写进 state.json，而状态文件有个 2 MB 的读取上限——
        // 不在这里挡住，用户一次性贴进一大段文本就能把项目**写成读不出来的样子**（REVIEW-tools L4）。
        const answerBytes = Buffer.byteLength(JSON.stringify(answers), 'utf8');
        if (answerBytes > MAX_ANSWER_BYTES) {
          fail(
            `这一轮答案有 ${Math.round(answerBytes / 1024)} KB，超过 ${MAX_ANSWER_BYTES / 1024} KB 上限`,
            '只记结论（一两句话即可）；长材料让用户自己存成文件，别贴进对话',
          );
        }
        const rounds = (state.clarify && state.clarify.rounds) || 0;
        if (rounds >= 2 && kind === 'detail') fail('澄清已经问满 2 轮', '用 plando_transition 传 clarify_done 把现状定下来');

        const draft = structuredClone(state);
        if (!isPlainObject(draft.clarify)) draft.clarify = { rounds: 0, answers: [], open: [] };
        if (!Array.isArray(draft.clarify.answers)) draft.clarify.answers = [];
        const questions = Array.isArray(input.questions) ? input.questions.filter(isNonEmptyString) : [];
        if (questions.length > 3) fail(`一轮最多记 3 个问题，这次传了 ${questions.length} 个`, '拆成两轮，或只留最关键的 3 个');
        draft.clarify.answers.push({ kind, questions, answers, at: new Date().toISOString() });
        draft.clarify.rounds = kind === 'detail' ? rounds + 1 : rounds;

        if (kind === 'baseline') {
          const experience = answers.experience;
          const goal = answers.goal;
          const hours = answers.hoursPerWeek;
          if (!['beginner', 'some', 'experienced'].includes(experience)) {
            fail('baseline.experience 必须是 beginner / some / experienced', '和用户确认经验水平后重传');
          }
          if (!['learn', 'ship'].includes(goal)) fail('baseline.goal 必须是 learn / ship', '确认目标是「学会」还是「做出来」后重传');
          if (!Number.isInteger(hours) || hours < 1 || hours > 60) {
            fail('baseline.hoursPerWeek 必须是 1–60 的整数', '问清每周能投入几小时后重传');
          }
          draft.baseline = { experience, hoursPerWeek: hours, goal };
        }
        appendLog(dir, deps, { kind: 'clarify', action: 'record', recordKind: kind });
        const saved = deps.project.saveState(dir, draft);
        // 这里**不**渲染 IDEA.md：契约 §2 把它挂在 clarify_done 上，澄清没做完就生成一份
        // 半空的 IDEA.md 反而会让人以为想法已经定稿。但 autoCommit 打开时要提交 .plando/
        // 里的状态，否则用户看到的仓库快照落后于真实进度（REVIEW-tools L7）。
        const commit = autoCommit(dir, deps, `plando(clarify): ${kind}`);
        const lines = [`已记录（${kind}，第 ${saved.clarify.rounds || 0} 轮）。`];
        if (commit && commit.committed) lines.push(`已自动提交：${commit.files.join('、')}`);
        lines.push('下一步：还需要补的内容用 plando_clarify 继续记；七个字段齐了就用 plando_transition 传 clarify_done 生成 IDEA.md。');
        return lines.join('\n');
      }, deps, 'plando_clarify');
    },
  };
}

function transitionTool(deps) {
  return {
    name: 'plando_transition',
    description:
      '推进状态机的唯一入口。传 event 加对应 payload；非法转移会被拒绝并留痕（写进 .plando/log.jsonl），不会静默生效。成功后会重渲染 IDEA.md / TECH.md 等产物并落盘。传之前先看 plando_status 给出的下一步。',
    parameters: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          enum: [...Object.keys(deps.state.TRANSITIONS)],
          description: '要推进的事件名（clarify_done / idea_ok / tech_ok / choose_verify / choose_build / choose_handoff / verify_result / cards_done / ship_pass / drop / revise / pause / resume / reopen）。',
        },
        dir: { type: 'string', description: '项目绝对路径；省略用 defaultProjectDir。' },
        payload: {
          description: '事件附加数据，按 CONTRACT §3 的形状传：clarify_done{what,done,notDo,users,assumptions,constraints,baseline}、tech_ok{items[]}、choose_verify{hypothesis,method,timeboxMin,judge}、choose_build{cards[]}、verify_result{result,evidence}、ship_pass{offlineOk,selfChange,explain}、drop{reason}、revise{reason}、reopen{reason}。',
        },
      },
      required: ['event'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const event = requireString(input, 'event', '传合法事件名；先看 plando_status 的「下一步」');
        if (event === 'pick') {
          fail('pick 不是状态机事件', '立项请用 plando_idea action=pick');
        }
        const dir = resolveDir(input, deps);
        const state = loadOrFail(dir, deps);
        const payload = normalizeObject(input.payload);
        const from = state.stage;
        const result = deps.state.applyEvent(state, event, payload, deps.config);
        if (!result.ok) {
          appendLog(dir, deps, { kind: 'reject', event, from, reason: result.reason });
          return `${result.reason}\n（已拒绝，并记录到 .plando/log.jsonl）`;
        }
        if (result.noop) return `无需推进：${event} 在当前状态没有变化（阶段仍是「${from}」）。`;

        const settled = afterTransition(dir, result.state, event, deps, { from });
        const effects = result.effects || {};
        const written = Array.isArray(settled.files) ? settled.files : [];
        const lines = [`已推进：${from} → ${settled.state.stage}（${event}）`];
        // 只报**真的写下去**的文件：effects.rerender 是「打算重渲染什么」，
        // 拿它当结果会谎报（revise 说重渲染 VERIFY.md，实际当时没写，REVIEW-state R5）。
        if (written.length > 0) lines.push(`落盘：${written.join('、')}`);
        const planned = Array.isArray(effects.rerender) ? effects.rerender : [];
        const skipped = planned.filter((name) => !written.includes(name) && !written.some((f) => f.startsWith(`${name}/`)));
        if (skipped.length > 0) lines.push(`本次没有重写：${skipped.join('、')}（当前状态还没有对应内容）`);
        if (Array.isArray(effects.invalidateCards) && effects.invalidateCards.length > 0) {
          lines.push(`已作废卡片：${effects.invalidateCards.join('、')}（需要重做，用 plando_card start 重开）`);
        }
        if (settled.commit) {
          lines.push(
            settled.commit.committed
              ? `已自动提交：${settled.commit.files.join('、')}`
              : `自动提交跳过：${settled.commit.reason || '无差异'}`,
          );
        }
        lines.push(`下一步：${deps.format.nextActionFor(settled.state.stage, settled.state) || '调 plando_status 看现状'}`);
        return lines.join('\n');
      }, deps, 'plando_transition');
    },
  };
}

function cardTool(deps) {
  return {
    name: 'plando_card',
    description:
      '逐卡推进（build 阶段）：action=start 开工，action=learn 记下这张卡学会了什么，action=do 记改过哪些文件，action=declare 给这张卡声明一条检查命令，action=done 收尾（必须有证据，不接受「我懂了」），action=downgrade 降级（必须写理由），action=list 看卡清单。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'learn', 'do', 'declare', 'done', 'downgrade', 'list'],
          description: '要做的卡片操作。',
        },
        id: { type: 'string', description: '卡片 id，如 c1；list 之外都必填。' },
        dir: { type: 'string', description: '项目绝对路径；省略用 defaultProjectDir。' },
        note: { type: 'string', description: 'learn：这张卡你学会了什么（一句话）。' },
        files: { type: 'array', items: { type: 'string' }, description: 'do：本次改动的文件路径数组。' },
        command: { type: 'string', description: 'declare：这条卡的可执行检查命令（如 node --test test/x.test.js），长度 ≤500。' },
        evidence: {
          description: 'done：证据对象 { kind: "check"|"files", summary: "..." }；summary 不能是「我懂了」这类空话。',
        },
        reason: { type: 'string', description: 'downgrade：为什么降级（如「时间不够，改成只跑通 demo」）。' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const action = requireString(input, 'action', '传 action=start / learn / do / declare / done / downgrade / list');
        const dir = resolveDir(input, deps);
        const state = loadOrFail(dir, deps);
        if (state.stage !== 'build' && action !== 'list') {
          fail(`现在是「${deps.state.STAGE_LABELS[state.stage] || state.stage}」阶段，还不能动卡片`, '先按下一步进到 build 阶段（plando_transition 传 choose_build）');
        }
        if (action === 'list') {
          const cards = Array.isArray(state.cards) ? state.cards : [];
          const progress = deps.cards.cardProgress(state);
          const lines = [
            `卡片：共 ${progress.total} 张，完成 ${progress.done}，降级 ${progress.downgraded}，在做 ${progress.doing}，待做 ${progress.todo}，作废 ${progress.stale}`,
          ];
          if (cards.length === 0) {
            lines.push('还没有卡片。下一步：plando_transition 传 choose_build 拆卡。');
            return lines.join('\n');
          }
          for (const card of cards) {
            const mark = card.id === progress.current ? '← 当前' : '';
            const done = card.status === 'done' ? '（已有证据）' : '';
            lines.push(`· ${card.id} [${card.status}] ${card.title}${done}${mark}`);
            if (!card.learn && card.status !== 'done') lines.push('  缺：学（action=learn）');
            if (!card.do && card.status !== 'done') lines.push('  缺：做（action=do）');
            if (!card.evidence && card.status !== 'done') lines.push('  缺：验（action=done 要证据）');
          }
          return lines.join('\n');
        }
        const id = requireString(input, 'id', '传卡片 id（先 action=list 看有哪些卡）');
        // REVIEW-tools G1b：declare 必须指向真实存在的卡，否则 checks.json 会和卡片脱钩，
        // 模型可以挂任意第 N 条命令并执行。list 之外的所有 action 都要先验 id 存在。
        const known = (Array.isArray(state.cards) ? state.cards : []).some((card) => card && card.id === id);
        if (!known) {
          fail(`卡片 ${id} 不存在`, '先 action=list 看真实卡 id，再传其中之一');
        }
        let result;
        if (action === 'declare') {
          const command = requireString(input, 'command', '写一条可直接执行的命令后重传');
          const declared = deps.checks.declareCheck(dir, id, command);
          if (!declared.ok) fail(declared.reason, '改写成一条简短命令再声明');
          appendLog(dir, deps, { kind: 'check', action: 'declare', cardId: id, command });
          return `已为卡片 ${id} 声明检查命令：${command}\n下一步：跑 plando_check（action=run，name=${id}），把结果作为 done 的证据。`;
        }
        if (action === 'start') result = deps.cards.startCard(state, id);
        else if (action === 'learn') result = deps.cards.setLearn(state, id, requireString(input, 'note', '用一句话写下这张卡学会了什么'));
        else if (action === 'do') {
          const files = Array.isArray(input.files) ? input.files.filter(isNonEmptyString) : [];
          if (files.length === 0) fail('do 需要 files（本次改了哪些文件）', '把改动过的文件路径填成数组后重传');
          result = deps.cards.setDo(state, id, files);
        } else if (action === 'done') {
          // 把「最近一次检查的凭据」读出来交给 doneCard 对账：`kind:'check'` 的证据必须在
          // .plando/last-check.json 里有对应的成功记录（REVIEW-tools M4）。
          const lastCheck = typeof deps.checks.readLastCheck === 'function' ? deps.checks.readLastCheck(dir) : null;
          result = deps.cards.doneCard(state, id, normalizeObject(input.evidence), { lastCheck });
        } else if (action === 'downgrade') result = deps.cards.downgradeCard(state, id, requireString(input, 'reason', '写一句降级理由后重传'));
        else fail(`不认识的 action：${action}`, '只支持 start / learn / do / declare / done / downgrade / list');

        if (!result.ok) fail(result.reason, '按提示补齐后重试；卡状态可以随时用 action=list 查看');
        // 先渲染（内存里，失败不影响磁盘）再落盘，避免「卡状态已变、卡 md 没更新」（REVIEW-tools M1）。
        const rendered = renderArtifacts(dir, result.state, deps);
        const saved = deps.project.saveState(dir, result.state);
        appendLog(dir, deps, { kind: 'card', action, cardId: id, files: rendered });
        autoCommit(dir, deps, `plando(build): card ${id} ${action}`);
        const progress = deps.cards.cardProgress(saved);
        return `卡片 ${id} 已 ${action}。\n进度：共 ${progress.total} 张，完成 ${progress.done}，降级 ${progress.downgraded}，未收尾 ${progress.todo + progress.doing + progress.stale}。\n下一步：${progress.total > 0 && progress.done + progress.downgraded === progress.total ? '所有卡已收尾，用 plando_transition 传 cards_done 进入收尾阶段。' : '继续做当前卡；全部收尾后传 cards_done。'}`;
      }, deps, 'plando_card');
    },
  };
}

function checkTool(deps) {
  return {
    name: 'plando_check',
    description:
      '跑任务卡声明的检查命令：action=run 执行一条已声明的检查（name=卡 id），action=list 看已声明了哪些。只运行 checks.json 里已经声明过的命令，不会临时执行别的命令；结果带退出码与输出，可直接作为 plando_card action=done 的证据。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'list'], description: 'run 跑一条已声明检查 / list 看已声明清单。' },
        name: { type: 'string', description: 'run 时必填：检查名（就是卡 id，如 c1）。' },
        dir: { type: 'string', description: '项目绝对路径；省略用 defaultProjectDir。' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const action = requireString(input, 'action', '传 action=run 或 list');
        const dir = resolveDir(input, deps);
        const state = loadOrFail(dir, deps);
        if (!['build', 'ship'].includes(state.stage)) {
          fail(`现在是「${deps.state.STAGE_LABELS[state.stage] || state.stage}」阶段，检查只在 build / ship 阶段跑`, '先推进到 build 阶段（plando_transition 传 choose_build）');
        }
        if (action === 'list') {
          const all = deps.checks.readChecks(dir);
          const keys = Object.keys(all);
          if (keys.length === 0) return '还没有声明任何检查命令。下一步：plando_card action=declare 给卡片绑定一条可执行检查。';
          const lines = [`已声明的检查（${keys.length} 条）：`];
          for (const key of keys) {
            const entry = all[key];
            const command = isPlainObject(entry) ? entry.command : entry;
            lines.push(`· ${key}：${command}`);
          }
          lines.push('跑一条：plando_check action=run name=<卡 id>');
          return lines.join('\n');
        }
        if (action !== 'run') fail(`不认识的 action：${action}`, '只支持 run / list');
        const name = requireString(input, 'name', '传检查名（就是卡 id），先 action=list 看已声明清单');
        const result = deps.checks.runCheck(dir, name);
        appendLog(dir, deps, { kind: 'check', action: 'run', name, ok: result.ok, exitCode: result.exitCode });
        const text = deps.format.formatCheck({ ...result, name });
        if (result.ok) {
          return `${text}\n下一步：把这次输出作为证据传给 plando_card action=done（evidence.kind='check'）。`;
        }
        return text;
      }, deps, 'plando_check');
    },
  };
}

function scaffoldTool(deps) {
  return {
    name: 'plando_scaffold',
    description:
      '写一个配置文件脚手架（只限白名单：package.json、tsconfig.json、.gitignore、.env.example、pyproject.toml、requirements.txt、Cargo.toml），内容还要过校验（package.json 的 scripts 只认 test / build / lint 这类键，postinstall 之类一律拒），且必须对应 TECH 清单里「归属=ai」的技术项。业务代码一律不写——那是用户自己写的。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '项目绝对路径；省略用 defaultProjectDir。' },
        path: { type: 'string', description: '要写的文件名（白名单里的顶层文件名，如 package.json）。' },
        content: { type: 'string', description: '文件完整内容。' },
        techId: { type: 'string', description: '对应 TECH 项 id（如 t3）；该项的 owner 必须是 ai。' },
      },
      required: ['path', 'content'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const dir = resolveDir(input, deps);
        const state = loadOrFail(dir, deps);
        if (state.stage !== 'build') {
          fail(`现在是「${deps.state.STAGE_LABELS[state.stage] || state.stage}」阶段，脚手架只在 build 阶段写`, '先推进到 build 阶段（plando_transition 传 choose_build）');
        }
        const relativePath = requireString(input, 'path', '传白名单里的文件名（如 package.json）');
        if (typeof input.content !== 'string') fail('content 必须是字符串', '把要写的文件完整内容作为字符串传入');
        const techItem = techItemOf(state, input.techId);
        if (!techItem) fail(`找不到 TECH 项 ${String(input.techId || '')}`, '先传 tech_ok 建好 TECH 清单，再传该项的 techId');
        // tools 层再查一次归属：scaffold.js 里也有这层，这里让拒绝理由更早、更清楚。
        if (techItem.owner !== 'ai') {
          fail(`TECH 项 ${techItem.id} 的归属是 ${techItem.owner}，不是 ai`, '只有「可交给 AI」的技术项才能写脚手架；把归属改成 ai 或让用户自己写这个文件');
        }
        // 把 checks.validateCommand 注入 scaffold：scripts 的值由它做 argv 级校验，
        // 两边共用一套白名单，避免第二份必然漂移的黑名单（REVIEW-tools §9.3）。
        const written = deps.scaffold.writeScaffold(dir, relativePath, input.content, techItem, {
          validateCommand: deps.checks.validateCommand,
        });
        if (!written.ok) fail(written.reason, '只写白名单里的顶层配置文件；业务代码由用户自己写');
        appendLog(dir, deps, { kind: 'scaffold', path: relativePath, techId: techItem.id, written: written.written });
        const tail = written.written === false ? '（文件已存在且内容相同，未重复写入）' : '';
        return `已写 ${relativePath}${tail}。\n已记录到日志。\n下一步：让用户确认这个配置能跑起来，再把检查结果作为卡片证据（plando_card action=done）。`;
      }, deps, 'plando_scaffold');
    },
  };
}

function statusTool(deps) {
  return {
    name: 'plando_status',
    description:
      '查看项目现在在哪个阶段、下一步该做什么、未解问题、任务卡进度、已生成的产物。开始任何动作前先调它；用户问「现在到哪了」时也调它。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '项目绝对路径；省略则用配置里的 defaultProjectDir。' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return run(args, async (input) => {
        const dir = resolveDir(input, deps);
        const loaded = deps.project.loadState(dir);
        // 读不出来不崩：给恢复指引（CONTRACT §4：绝不重置）。
        if (!loaded.ok) return deps.format.formatRecover(loaded.reason, dir);
        const state = loaded.state;
        return deps.format.formatStatus({
          state,
          projectDir: dir,
          progress: deps.cards.cardProgress(state),
          pending: (state.clarify && state.clarify.open) || [],
          artifacts: existingArtifacts(dir),
          budget: state.budget,
        });
      }, deps, 'plando_status');
    },
  };
}

// 按 id 找 TECH 项；没给 id 时返回 undefined（tools 层不猜）。
function techItemOf(state, techId) {
  const items = state && state.tech && Array.isArray(state.tech.items) ? state.tech.items : [];
  if (!isNonEmptyString(techId)) return undefined;
  return items.find((item) => item && item.id === techId.trim());
}

/**
 * 注册 8 个工具。
 * @param {object} ctx DSH 插件 ctx（只用到 ctx.tools.register）
 * @param {object} deps 见 docs/INTERFACES.md §4
 * @returns {string[]} 实际注册成功的工具名
 */
export function registerTools(ctx, deps) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('plando：ctx.tools.register 不可用，拿不到工具注册表——换一个支持工具注册的 DSH 版本。');
  }
  const builders = [
    statusTool,
    projectTool,
    ideaTool,
    clarifyTool,
    transitionTool,
    cardTool,
    checkTool,
    scaffoldTool,
  ];
  const registered = [];
  for (const build of builders) {
    const definition = build(deps);
    ctx.tools.register(definition);
    registered.push(definition.name);
  }
  return registered;
}


