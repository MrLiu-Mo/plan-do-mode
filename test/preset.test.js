// test/preset.test.js —— 预设（cordis.patch.yml）的文本断言。
//
// 不引 YAML 解析器（本包零依赖，测试也不破例）：把 yml 当纯文本，
// 断言结构骨架、关键字段、persona 正文的长度与关键词。
// 这些断言守的是「装上去能挂住、且挂的是对的东西」——比风格检查更重要。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YML_PATH = path.join(ROOT, 'cordis.patch.yml');

const raw = fs.readFileSync(YML_PATH, 'utf8');
// 行尾统一按 LF 处理：仓库在 Windows 上可能被 core.autocrlf 检出成 CRLF，
// 断言不该因为行尾而红（内容判定与行尾无关）。
const lines = raw.replace(/\r\n/g, '\n').split('\n');

// 去掉注释行与空行，剩下的是「有效 YAML」；顶层第一个有效行必须是 - insert:。
const effective = lines.filter((line) => {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
});

// 取 prefix: |- 之后的块标量正文：属于它的行缩进都比 prefix 那行深。
// 遇到缩进回到 prefix 同级或更浅的非空行就结束（下一个同级键）。
function extractBlockScalar(key) {
  const keyLineIndex = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*\\|-\\s*$`).test(line));
  assert.ok(keyLineIndex >= 0, `cordis.patch.yml 里没找到 \`${key}: |-\` 块`);
  const keyIndent = lines[keyLineIndex].length - lines[keyLineIndex].trimStart().length;
  const body = [];
  for (let i = keyLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    body.push(line.trim());
  }
  return { text: body.join('\n'), lines: body };
}

test('cordis.patch.yml 存在，顶层结构以 - insert: 起头', () => {
  assert.ok(fs.existsSync(YML_PATH), 'cordis.patch.yml 必须存在于仓库根');
  assert.equal(effective[0], '- insert:', '顶层第一个有效行必须是 `- insert:`（API-FACTS §6）');
});

test('插入的是 preset-plan-do 节点，挂在 dsh-agent-preset 包上', () => {
  const mustInclude = [
    'preset-plan-do',
    "@deepseek-ai/dsh-agent-preset",
  ];
  for (const needle of mustInclude) {
    assert.ok(raw.includes(needle), `cordis.patch.yml 缺少 \`${needle}\``);
  }
});

test('预设的身份字段：id / name / order / description', () => {
  assert.match(raw, /^\s+id: plan-do\s*$/mu, '预设 id 必须是 plan-do');
  assert.match(raw, /^\s+name: 边学边做\s*$/mu, '预设名必须是「边学边做」');
  assert.match(raw, /^\s+order: 25\s*$/mu, '预设 order 必须是 25');
  assert.match(raw, /^\s+description: \S+/mu, '预设必须有 description');
});

test('插件项：persona + 本包 dsh-plan-do，且不误挂 plan-mode', () => {
  assert.ok(raw.includes('@deepseek-ai/dsh-persona'), 'persona 插件必须挂上');
  assert.match(raw, /^\s+name: 'dsh-plan-do'\s*$/mu, '插件项 name 必须是包名 dsh-plan-do（不是路径）');
  assert.ok(
    !raw.includes('dsh-plan-mode'),
    '不要挂 @deepseek-ai/dsh-plan-mode：两套流程叠加会互相打架（API-FACTS §6）',
  );
});

test('不挂会导致漏写的工具：bash / pwsh / subagent / workflow', () => {
  // 结构性防线的落点：这些工具一旦写进 plugins，模型就有能力绕过「不代写」。
  const forbidden = ['dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-tool-subagent', 'dsh-tool-workflow', 'dsh-tool-jobs'];
  for (const pkg of forbidden) {
    assert.ok(!raw.includes(pkg), `预设里不能挂 ${pkg}`);
  }
});

test('读工具挂上、写工具关掉（第一道防线）', () => {
  // persona 里承诺「有读工具、没有写工具」，这里把它落成结构断言：
  // 只要有人把 write/edit 打开，这条测试就会红。
  assert.ok(raw.includes('@deepseek-ai/dsh-tool-fs'), '必须挂只读的 dsh-tool-fs');
  assert.ok(raw.includes('@deepseek-ai/dsh-tool-fs-search'), '必须挂 glob / grep（模型要能读代码来验收）');
  assert.match(raw, /^\s+write: false\s*$/mu, 'dsh-tool-fs 必须显式 write: false');
  assert.match(raw, /^\s+edit: false\s*$/mu, 'dsh-tool-fs 必须显式 edit: false');
});

test('persona 正文长度在 2000–4000 字之间', () => {
  const { text } = extractBlockScalar('prefix');
  const body = text.replace(/\s+/gu, '');
  assert.ok(
    body.length >= 2000,
    `persona 正文太短（${body.length} 字，要求 2000–4000）：太短拦不住模型`,
  );
  assert.ok(
    body.length <= 4000,
    `persona 正文太长（${body.length} 字，要求 2000–4000）：每轮都进系统提示词，挤占上下文`,
  );
});

test('persona 必须覆盖六件事的关键词', () => {
  const { text } = extractBlockScalar('prefix');
  const required = [
    '不代写',        // ① 你是谁
    'plando_status', // ② 阶段意识
    'plando_transition', // ③ 工具优先级 / 唯一推进入口
    '验收',          // ⑤ 验收标准
    '证据',          // ⑤ done 必须有证据
    '语气',          // ⑥ 语气约定
  ];
  for (const needle of required) {
    assert.ok(text.includes(needle), `persona 正文缺少关键词「${needle}」`);
  }
});

test('persona 列出 11 个阶段的名字', () => {
  const { text } = extractBlockScalar('prefix');
  const stages = ['inbox', 'clarify', 'idea', 'tech', 'decide', 'verify', 'build', 'ship', 'done', 'handoff', 'dropped'];
  for (const stage of stages) {
    assert.ok(text.includes(stage), `persona 正文没有提到阶段 ${stage}`);
  }
});

test('persona 写明「有读工具、没有写工具」并给出拒绝话术示例', () => {
  const { text } = extractBlockScalar('prefix');
  // 这比单纯说「不许代写」更硬：模型知道自己物理上做不到，就不会反复试探。
  assert.ok(text.includes('没有写工具'), 'persona 必须明确说「你没有写工具」');
  assert.ok(text.includes('读工具'), 'persona 必须明确说「你有读工具」');
  // 有一个具体的对话示例，比只有规则时更容易守住。
  assert.ok(
    /用户说「[^」]*你[^」]*写[^」]*」[^。]*你回：/u.test(text),
    'persona 要给出「用户要求代写 → 怎么回」的具体话术示例',
  );
});

test('persona 不复述 CONTRACT 的事件表（防漂移）', () => {
  const { text } = extractBlockScalar('prefix');
  // 事件名出现在 persona 里意味着提示词在替 state.js 背书，改一处就会漂移。
  const eventNames = ['clarify_done', 'idea_ok', 'tech_ok', 'choose_verify', 'choose_build', 'cards_done', 'ship_pass', 'verify_result', 'choose_handoff'];
  const leaked = eventNames.filter((name) => text.includes(name));
  assert.deepEqual(leaked, [], `persona 里不要出现事件名（应只说「按工具返回的下一步走」）：${leaked.join(', ')}`);
});

test('plugins: 下每项 - id: 的对齐一致', () => {
  const pluginsIndex = lines.findIndex((line) => /^\s*plugins:\s*$/.test(line));
  assert.ok(pluginsIndex >= 0, '没找到 plugins: 列表');
  const pluginsIndent = lines[pluginsIndex].length - lines[pluginsIndex].trimStart().length;

  const entries = [];
  for (let i = pluginsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= pluginsIndent) break; // plugins 块结束
    const m = line.match(/^(\s*)- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
    if (m) entries.push({ indent: m[1].length, id: m[2], lineNo: i + 1 });
  }

  assert.ok(entries.length >= 2, `plugins: 下至少要挂两项，实际解析到 ${entries.length}`);
  const minIndent = Math.min(...entries.map((e) => e.indent));
  const topLevel = entries.filter((e) => e.indent === minIndent);
  // 头两项固定是 persona 与 plan-do-mode（前者立规矩，后者提供 8 个工具）。
  assert.deepEqual(
    topLevel.slice(0, 2).map((e) => e.id),
    ['persona', 'plan-do-mode'],
    '插件清单的前两项必须是 persona、plan-do-mode（顺序一致）',
  );
  // 对齐检查：第一层与 group 子项只允许两种缩进（差 4 的倍数），不允许「手抖多一个空格」。
  const allowedIndents = new Set([minIndent, minIndent + 4]);
  for (const entry of entries) {
    assert.equal(
      entry.indent % 2,
      0,
      `第 ${entry.lineNo} 行（${entry.id}）缩进 ${entry.indent} 不是偶数，YAML 缩进应统一用 2 空格`,
    );
    assert.ok(
      allowedIndents.has(entry.indent),
      `第 ${entry.lineNo} 行（${entry.id}）缩进 ${entry.indent} 与同批项不对齐（第一层 ${minIndent}，group 子项 ${minIndent + 4}）`,
    );
  }
});
