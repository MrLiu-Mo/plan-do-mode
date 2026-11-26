// test/artifacts.test.js
// R2：lib/artifacts.js 的渲染契约测试。
// 约定：
//   - 用例之间不共享可变状态；每个用例用 makeState(overrides) 自己造 state。
//   - 故意不 import lib/state.js（它由另一轮实现，这里只依赖 CONTRACT §4 的形状）。
//   - 只断言必须为真的东西：标题/列名逐字相等，其余用正则或包含关系。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'artifacts.js')).href;
const artifacts = await import(ARTIFACTS_URL);

const {
  renderIdea,
  renderTech,
  renderVerify,
  renderHandoff,
  renderChangeGuide,
  renderCard,
  checkIdeaStructure,
  checkTechStructure,
} = artifacts;

// --- 工厂：按 CONTRACT §4 的 state 形状造数据 ---------------------------------

/** 造一个 TECH 项（9 字段齐全）。 */
function makeItem(overrides = {}) {
  return {
    id: 't1',
    title: '读懂 JSON 读写',
    why: '账目要落盘',
    ifMissing: '数据一关就丢',
    owner: 'user',
    difficulty: 1,
    minutes: 60,
    judge: '能读出刚写的 3 条记录',
    file: 'src/store.js',
    ...overrides,
  };
}

/** 造一张卡（Card 形状见 CONTRACT §4）。 */
function makeCard(overrides = {}) {
  return {
    id: 'c1',
    techIds: ['t1'],
    title: '把账目存下来',
    status: 'todo',
    learn: null,
    do: null,
    verify: null,
    evidence: null,
    startedAt: null,
    doneAt: null,
    ...overrides,
  };
}

/** 造一个完整 state；传 overrides 覆盖任意一层（浅覆盖，够用）。 */
function makeState(overrides = {}) {
  const base = {
    schemaVersion: 1,
    projectId: 'proj_12345678',
    name: '记账小工具',
    dir: 'C:/tmp/plando-demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stage: 'tech',
    paused: false,
    idea: {
      id: 'idea_1',
      title: '记账小工具',
      oneLine: '一句话把账记下来，月底自动汇总。',
      users: '我自己（一个人用）',
      mvp: ['记一笔支出', '看本月合计'],
      acceptance: ['能连续记 3 笔，并在汇总里看到合计'],
      notDo: ['不做多用户', '不做云同步'],
      assumptions: ['我每天愿意花 10 秒记一笔'],
      constraints: { budget: '600 分钟', platform: 'Windows', tech: 'Node', promiseRisk: false },
    },
    baseline: { experience: 'beginner', hoursPerWeek: 5, goal: 'ship' },
    clarify: { rounds: 2, answers: [], open: [] },
    tech: {
      items: [
        makeItem({ id: 't1', title: '读懂 JSON 读写', owner: 'user', minutes: 60 }),
        makeItem({
          id: 't2',
          title: '命令行参数',
          why: '记账入口',
          ifMissing: '没法从命令行输入',
          owner: 'ai',
          difficulty: 2,
          minutes: 30,
          judge: 'node app.js add 12 能写入一条',
          file: 'src/cli.js',
        }),
        makeItem({
          id: 't3',
          title: '按步骤跑通测试',
          why: '改完能自证',
          ifMissing: '不知道坏没坏',
          owner: 'follow',
          difficulty: 1,
          minutes: 20,
          judge: 'node --test 全绿',
          file: 'test/store.test.js',
        }),
      ],
      size: 'small',
      sizeReason: '预计 110 分钟',
      threshold: 300,
    },
    decision: { choice: null, history: [] },
    verify: {
      hypothesis: '我能在 3 天内坚持记账',
      method: '手记 3 天，每天一笔',
      timeboxMin: 30,
      judge: '满 3 条记录',
      result: null,
      evidence: '',
      overtime: false,
    },
    cards: [makeCard()],
    ship: { offlineOk: false, selfChange: false, explain: '' },
    terminal: null,
  };
  return { ...base, ...overrides };
}

// --- IDEA.md ---------------------------------------------------------------

const IDEA_HEADINGS = [
  '## 一句话',
  '## 谁用',
  '## 做什么（MVP）',
  '## 怎么算成',
  '## 什么不做',
  '## 关键假设',
  '## 约束',
  '## 用户基线',
];

test('renderIdea：8 个小节标题逐字一致且顺序固定', () => {
  const text = renderIdea(makeState());
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '# 记账小工具', '首行必须是一级标题 + 项目名');
  const headingLines = lines.filter((line) => line.startsWith('## '));
  assert.deepEqual(headingLines, IDEA_HEADINGS);
});

test('renderIdea：关键内容真的落进了对应小节', () => {
  const text = renderIdea(makeState());
  assert.match(text, /一句话把账记下来/);
  assert.match(text, /我自己（一个人用）/);
  assert.match(text, /- 记一笔支出/);
  assert.match(text, /- 能连续记 3 笔/);
  assert.match(text, /- 不做多用户/);
  assert.match(text, /- 我每天愿意花 10 秒记一笔/);
  assert.match(text, /预算：600 分钟/);
  assert.match(text, /经验：新手/);
  assert.match(text, /每周可用：5 小时/);
});

test('renderIdea：空 state 也产出完整结构，不抛错', () => {
  const full = renderIdea(makeState());
  assert.deepEqual(checkIdeaStructure(full), []);

  // 空 state 的小节骨架仍然是完整的（只是内容变成占位），这是纯函数该有的稳定性。
  const bare = renderIdea({});
  assert.equal(typeof bare, 'string');
  assert.deepEqual(checkIdeaStructure(bare), []);
  assert.match(bare, /（未命名项目）/);
  assert.match(bare, /（待填写）/);
});

test('checkIdeaStructure：返回缺失标题，空数组表示完整', () => {
  const complete = renderIdea(makeState());
  assert.deepEqual(checkIdeaStructure(complete), []);

  const text = complete.replace('## 关键假设', '## 假设');
  const missing = checkIdeaStructure(text);
  assert.deepEqual(missing, ['## 关键假设']);

  const empty = checkIdeaStructure('');
  assert.equal(empty.length, IDEA_HEADINGS.length + 1, '空文本连首行标题一起缺');
  assert.ok(empty.includes('# <name>'));
});

// --- TECH.md ---------------------------------------------------------------

const TECH_HEADER_LINE =
  '| id | 技术项 | 为什么需要 | 不会怎样错 | 归属 | 难度 | 分钟 | 过关判据 | 文件 |';
const TECH_SEPARATOR_LINE = '|---|---|---|---|---|---|---|---|---|';

test('renderTech：9 列表头逐字一致', () => {
  const text = renderTech(makeState());
  const lines = text.split(/\r?\n/);
  assert.ok(lines.includes(TECH_HEADER_LINE), '表头必须逐字等于契约里的 9 列表头');
  const headerIndex = lines.indexOf(TECH_HEADER_LINE);
  assert.equal(lines[headerIndex + 1], TECH_SEPARATOR_LINE, '表头下一行必须是分隔行');
  assert.equal(lines[0], '# 记账小工具 技术拆解');
});

test('renderTech：按 owner 分组，user 在前', () => {
  const text = renderTech(makeState());
  const userIndex = text.indexOf('### 归属 user');
  const followIndex = text.indexOf('### 归属 follow');
  const aiIndex = text.indexOf('### 归属 ai');
  assert.ok(userIndex >= 0 && followIndex >= 0 && aiIndex >= 0, '三组都要出现');
  assert.ok(userIndex < followIndex && followIndex < aiIndex, '顺序必须是 user → follow → ai');

  const lines = text.split(/\r?\n/);
  const rows = lines.filter((line) => /^\| t\d /.test(line));
  assert.deepEqual(
    rows.map((line) => line.split(' | ')[0].replace('| ', '')),
    ['t1', 't3', 't2'],
    'user 项 t1 → follow 项 t3 → ai 项 t2',
  );
});

test('renderTech：每行 9 个单元格，内容落在正确列', () => {
  const text = renderTech(makeState());
  const rows = text.split(/\r?\n/).filter((line) => /^\| t\d /.test(line));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const cells = row.slice(1, -1).split(' | ');
    assert.equal(cells.length, 9, `行应有 9 列：${row}`);
  }
  const t1 = rows.find((line) => line.startsWith('| t1 '));
  assert.ok(t1.includes('| 读懂 JSON 读写 |'));
  assert.ok(t1.includes('| 账目要落盘 |'));
  assert.ok(t1.includes('| 数据一关就丢 |'));
  assert.ok(t1.includes('| user |'));
  assert.ok(t1.includes('| 60 |'));
  assert.ok(t1.includes('| src/store.js |'));
});

test('renderTech：表格下方汇总 user 条数 / 总分钟 / 预算', () => {
  const text = renderTech(makeState());
  assert.match(text, /user 项 1 条 \/ 总计 110 分钟 \/ 预算 5 条 \/ 600 分钟/);
  // 汇总必须在最后一行表格之后
  const lastRow = text.lastIndexOf('| src/store.js |');
  assert.ok(text.indexOf('user 项 1 条') > lastRow);
});

test('renderTech：自定义预算被采用', () => {
  const state = makeState({ budget: { mustUnderstand: 2, totalMinutes: 120 } });
  const text = renderTech(state);
  assert.match(text, /预算 2 条 \/ 120 分钟/);
});

test('renderTech：没有 TECH 项时仍产出可解析的结构', () => {
  const state = makeState({ tech: { items: [], size: 'small', sizeReason: '' } });
  const text = renderTech(state);
  assert.deepEqual(checkTechStructure(text), []);
  assert.match(text, /user 项 0 条 \/ 总计 0 分钟/);
});

test('renderTech：规模行同时给出总计分钟与阈值，判大时不把数字说两遍', () => {
  const small = mountTechSize({ size: 'small', sizeReason: '', total: 110, threshold: 300 });
  assert.match(small, /规模：小（总计 110 分钟，阈值 300 分钟）/);

  // 判大的原因就是「超阈值」时，一句话说完，不要再把「总计 310、阈值 300」重复一遍。
  const large = mountTechSize({ size: 'large', sizeReason: '预计 310 分钟，超过 300 分钟阈值', total: 310, threshold: 300 });
  const largeSizeLine = large.split('\n').find((line) => line.startsWith('- 规模：'));
  assert.match(largeSizeLine, /规模：大——预计 310 分钟，超过 300 分钟阈值/);
  assert.equal(largeSizeLine.split('310 分钟').length - 1, 1, '310 分钟在规模行里只该出现一次');
  assert.doesNotMatch(largeSizeLine, /阈值 300 分钟）/, '不该再出现括号形式的阈值');

  // 判大的原因不是分钟数（承诺风险）时，才需要把「总计/阈值」和「原因」分两段写。
  const risky = mountTechSize({ size: 'large', sizeReason: '承诺风险', total: 100, threshold: 300 });
  assert.match(risky, /规模：大（总计 100 分钟，阈值 300 分钟）——承诺风险/);

  // 阈值随 state.tech.threshold 走（立项快照），不是写死的 300。
  const custom = mountTechSize({ size: 'large', sizeReason: '预计 200 分钟，超过 150 分钟阈值', total: 200, threshold: 150 });
  assert.match(custom, /超过 150 分钟阈值/);
});

// 造一个只有规模相关字段的 TECH.md，返回渲染文本。
function mountTechSize({ size, sizeReason, total, threshold }) {
  const state = makeState({
    tech: {
      items: [makeItem({ id: 't1', owner: 'user', minutes: total })],
      size,
      sizeReason,
      threshold,
    },
  });
  return renderTech(state);
}

test('renderTech：state 没有 threshold 字段（老项目）时不写「阈值」，也不炸', () => {
  const state = makeState({ tech: { items: [makeItem()], size: 'small', sizeReason: '' } });
  const text = renderTech(state);
  assert.match(text, /规模：小（总计 60 分钟）/);
  assert.doesNotMatch(text, /阈值/);
});

test('checkTechStructure：返回缺失项，空数组表示完整', () => {
  const complete = renderTech(makeState());
  assert.deepEqual(checkTechStructure(complete), []);

  const noHeader = complete.split(TECH_HEADER_LINE).join('| id | 技术项 |');
  assert.deepEqual(checkTechStructure(noHeader), [TECH_HEADER_LINE]);

  const noBudget = complete.split('## 预算汇总').join('## 预算');
  const missing = checkTechStructure(noBudget);
  assert.ok(missing.includes('## 预算汇总'));
});

// --- 纯函数性与字段容错 -----------------------------------------------------

test('所有渲染函数是纯函数：同 state 逐字节相同', () => {
  const state = makeState();
  const first = {
    idea: renderIdea(state),
    tech: renderTech(state),
    verify: renderVerify(state),
    handoff: renderHandoff(state),
    guide: renderChangeGuide(state),
    card: renderCard(state, state.cards[0]),
  };
  // 深拷贝后再渲染，避免「缓存同一个对象」造成的假通过
  const clone = JSON.parse(JSON.stringify(state));
  const second = {
    idea: renderIdea(clone),
    tech: renderTech(clone),
    verify: renderVerify(clone),
    handoff: renderHandoff(clone),
    guide: renderChangeGuide(clone),
    card: renderCard(clone, clone.cards[0]),
  };
  assert.deepEqual(second, first);
  // 同一对象连续调用两次也必须一致（不能悄悄改 state）
  assert.equal(renderIdea(state), first.idea);
  assert.equal(renderTech(state), first.tech);
});

test('渲染不改动传入的 state', () => {
  const state = makeState();
  const snapshot = JSON.stringify(state);
  renderIdea(state);
  renderTech(state);
  renderVerify(state);
  renderHandoff(state);
  renderChangeGuide(state);
  renderCard(state, state.cards[0]);
  assert.equal(JSON.stringify(state), snapshot);
});

test('渲染对缺字段容错：不抛错、不出现 undefined', () => {
  const state = makeState({
    idea: {},
    baseline: {},
    tech: { items: [{}], size: undefined, sizeReason: undefined },
    cards: [{}],
    verify: {},
    decision: { choice: null, history: [] },
  });
  const outputs = [
    renderIdea(state),
    renderTech(state),
    renderVerify(state),
    renderHandoff(state),
    renderChangeGuide(state),
    renderCard(state, state.cards[0]),
  ];
  for (const output of outputs) {
    assert.equal(typeof output, 'string');
    assert.ok(!output.includes('undefined'), `产物里不能出现 undefined：${output}`);
    assert.ok(!output.includes('null'), `产物里不能出现 null：${output}`);
  }
});

test('渲染对畸形 state 容错：6 组坏形状都不抛错、不泄漏 undefined/null', () => {
  // 固化自开发期的 fuzz：state 可能来自半写文件、clarify 半成品或人工编辑，
  // 渲染器必须在任何形状下都返回字符串（产物宁可有占位，也不能崩）。
  const weirdStates = [
    null,
    undefined,
    {},
    { idea: 'x', baseline: 'y', tech: 'z', cards: 'w' },
    { idea: { constraints: 'nope', mvp: [1, null, 'a'] }, baseline: { hoursPerWeek: 'many' } },
    { tech: { items: [null, 1, 'x', { id: 3 }] }, cards: [null, 1] },
    { verify: { timeboxMin: 'abc' }, name: 42 },
  ];
  assert.equal(weirdStates.length, 7, '6 组坏形状 + 1 组完全空');
  for (const state of weirdStates) {
    const cards = Array.isArray(state?.cards) ? state.cards : [undefined];
    const outputs = [
      renderIdea(state),
      renderTech(state),
      renderVerify(state),
      renderHandoff(state),
      renderChangeGuide(state),
      renderCard(state, cards[0]),
    ];
    for (const output of outputs) {
      assert.equal(typeof output, 'string', `state=${JSON.stringify(state)} 应返回字符串`);
      assert.ok(!output.includes('undefined'), '产物里不能出现 undefined');
      assert.ok(!output.includes('null'), '产物里不能出现 null');
    }
  }
});

// --- 卡片正文 ---------------------------------------------------------------

test('renderCard：含「学 / 做 / 验」三段小标题且顺序固定', () => {
  const state = makeState();
  const text = renderCard(state, state.cards[0]);
  const lines = text.split(/\r?\n/);
  const sections = lines.filter((line) => /^## (学|做|验)$/.test(line));
  assert.deepEqual(sections, ['## 学', '## 做', '## 验']);
  assert.equal(lines[0], '# 把账目存下来', '首行是卡片标题');
});

test('renderCard：每段都有可执行判据，不是空话', () => {
  const state = makeState();
  const text = renderCard(state, state.cards[0]);
  const [learn, doPhase, verify] = ['## 学', '## 做', '## 验'].map((heading) => {
    const start = text.indexOf(heading);
    const rest = text.slice(start + heading.length);
    const nextHeading = rest.search(/\n## /);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  });
  assert.match(learn, /判据：/, '「学」段要有判据句');
  assert.match(learn, /不用它就会/, '「学」段要指出不学的后果');
  assert.match(doPhase, /判据：/, '「做」段要有判据句');
  assert.match(doPhase, /改\/新增：src\/store\.js/, '「做」段要落到具体文件');
  assert.match(verify, /判据：/, '「验」段要有判据句');
  assert.match(verify, /过关判据：能读出刚写的 3 条记录/, '「验」段引用 TECH 的过关判据');
  assert.match(verify, /退出码/, '「验」段要求退出码');
});

test('renderCard：有笔记/文件/输出时渲染真实内容', () => {
  const state = makeState();
  const card = makeCard({
    status: 'doing',
    learn: { note: 'JSON.parse 读不了 undefined', at: '2026-01-02T00:00:00.000Z' },
    do: { files: ['src/store.js', 'test/store.test.js'], at: '2026-01-03T00:00:00.000Z' },
    verify: { output: '# pass 4', exitCode: 0, at: '2026-01-04T00:00:00.000Z' },
    evidence: { kind: 'check', summary: 'node --test 全绿', at: '2026-01-04T00:00:00.000Z' },
    startedAt: '2026-01-02T00:00:00.000Z',
    doneAt: '2026-01-04T00:00:00.000Z',
  });
  const text = renderCard(state, card);
  assert.match(text, /JSON\.parse 读不了 undefined/);
  assert.match(text, /改\/新增：test\/store\.test\.js/);
  assert.match(text, /# pass 4/);
  assert.match(text, /退出码：0/);
  assert.match(text, /类型：检查输出/);
  assert.match(text, /摘要：node --test 全绿/);
  assert.match(text, /状态：进行中/);
});

test('renderCard：卡片没挂 TECH 项时给出明确提示，而不是空白', () => {
  const state = makeState();
  const card = makeCard({ techIds: [], title: '未挂项' });
  const text = renderCard(state, card);
  assert.match(text, /这张卡还没挂 TECH 项/);
  assert.match(text, /还没有证据/);
});

// --- VERIFY.md / HANDOFF.md / CHANGE-GUIDE.md ------------------------------

test('renderVerify：时间盒、判据、结果都在', () => {
  const state = makeState();
  state.verify.result = 'pass';
  state.verify.evidence = '三天手记截图';
  const text = renderVerify(state);
  assert.match(text, /# 记账小工具 小验证/);
  assert.match(text, /我能在 3 天内坚持记账/);
  assert.match(text, /时间盒：30 分钟/);
  assert.match(text, /满 3 条记录/);
  assert.match(text, /结果：通过/);
  assert.match(text, /证据：三天手记截图/);
});

test('renderVerify：未记录结果时提示下一步动作', () => {
  const text = renderVerify(makeState());
  assert.match(text, /还没记录/);
  assert.match(text, /verify_result/);
  assert.ok(!text.includes('undefined'));
});

test('renderHandoff：写出交给 AI 的项、验收标准与不做清单', () => {
  const state = makeState();
  const text = renderHandoff(state);
  assert.match(text, /# 记账小工具 交接单/);
  assert.match(text, /命令行参数/, 'ai 归属的 TECH 项要列出来');
  assert.match(text, /- 能连续记 3 笔/, '验收标准来自 idea.acceptance');
  assert.match(text, /- 不做多用户/, '不做清单来自 idea.notDo');
  assert.ok(!text.includes('读懂 JSON 读写'), 'user 归属的项不该出现在交接单的技术清单里');
});

test('renderChangeGuide：作废的卡被点名，历史选路被引用', () => {
  const state = makeState({
    cards: [makeCard({ status: 'stale', title: '旧卡' }), makeCard({ id: 'c2', title: '好卡' })],
    decision: { choice: 'verify', history: [{ choice: 'verify', at: '2026-01-05T00:00:00.000Z' }] },
  });
  const text = renderChangeGuide(state);
  assert.match(text, /c1 旧卡（需要重做）/);
  assert.ok(!text.includes('好卡（需要重做）'), '非 stale 卡不该被点名');
  assert.match(text, /上次选路：小验证/);
});

test('renderChangeGuide：没有变化时也给出明确的下一步', () => {
  const text = renderChangeGuide(makeState());
  assert.match(text, /没有卡被作废/);
  assert.match(text, /plando_transition/);
});

// --- 零依赖与结构完整性 -----------------------------------------------------

test('artifacts.js 只 import node: 内置模块或本目录文件（零依赖）', async () => {
  const source = await readFile(path.join(HERE, '..', 'lib', 'artifacts.js'), 'utf8');
  const importPattern = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/g;
  const specifiers = [];
  let match = importPattern.exec(source);
  while (match) {
    specifiers.push(match[1]);
    match = importPattern.exec(source);
  }
  const dynamicPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  match = dynamicPattern.exec(source);
  while (match) {
    specifiers.push(match[1]);
    match = dynamicPattern.exec(source);
  }
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
      `出现非 node: 非相对路径的 import：${specifier}`,
    );
  }
  assert.ok(!source.includes('@deepseek-ai/'), '不允许 import @deepseek-ai/* 裸包名');
});

test('renderTech：预算读取顺序为 options.budget → state.budget → 契约默认 5/600', () => {
  // 约定（Lead 定稿）：state.budget 是主来源；options.budget 只作测试/覆盖用。
  const withState = makeState({ budget: { mustUnderstand: 4, totalMinutes: 480 } });
  assert.match(renderTech(withState), /预算 4 条 \/ 480 分钟/);

  // options 显式传入时优先（测试覆盖用）。
  assert.match(
    renderTech(withState, { budget: { mustUnderstand: 3, totalMinutes: 300 } }),
    /预算 3 条 \/ 300 分钟/,
  );

  // 两者都没有 → 契约默认 5 条 / 600 分钟。
  assert.match(renderTech(makeState()), /预算 5 条 \/ 600 分钟/);
});

test('枚举取值不依赖原型链：怪键不会把函数名渲染进产物', () => {
  const state = makeState();
  state.baseline = { experience: 'toString', hoursPerWeek: 5, goal: 'constructor' };
  state.verify.result = 'hasOwnProperty';
  state.decision = { choice: 'valueOf', history: [] };
  const card = makeCard({ status: 'isPrototypeOf' });
  const outputs = [
    renderIdea(state),
    renderVerify(state),
    renderChangeGuide(state),
    renderCard(state, card),
  ];
  for (const output of outputs) {
    assert.ok(!/function /.test(output), '产物里不能出现函数源码');
    assert.ok(!output.includes('[object'), '产物里不能出现 [object Object]');
  }
});

test('checkIdeaStructure / checkTechStructure 接受 CRLF 文本', () => {
  const ideaCrlf = renderIdea(makeState()).replace(/\n/g, '\r\n');
  assert.deepEqual(checkIdeaStructure(ideaCrlf), []);
  const techCrlf = renderTech(makeState()).replace(/\n/g, '\r\n');
  assert.deepEqual(checkTechStructure(techCrlf), []);
});

test('渲染结果不含时间戳以外的随机性（连跑两次完全一致）', () => {
  const state = makeState();
  const snapshot = JSON.stringify(state);
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    runs.push([
      renderIdea(state),
      renderTech(state),
      renderVerify(state),
      renderHandoff(state),
      renderChangeGuide(state),
      renderCard(state, state.cards[0]),
    ]);
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
  assert.equal(JSON.stringify(state), snapshot);
});


