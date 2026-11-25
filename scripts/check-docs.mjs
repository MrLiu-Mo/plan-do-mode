#!/usr/bin/env node
/**
 * 文档一致性检查（零依赖，只用 node: 内置模块）。
 *
 * 为什么需要它：这个项目的「接口」不只写在代码里，也写在三份文档里——
 * PLAN.md（需求与验收）、docs/CONTRACT.md（state.js 契约）、docs/DEV-PROMPTS.md（开发指令）、
 * docs/API-FACTS.md（DSH API 事实）。文档之间一旦对不上，实现者 AI 会照错的版本去写，
 * 而且要到很晚才发现。所以把「对得上」变成一条能跑的命令。
 *
 * 用法：node scripts/check-docs.mjs
 * 通过时打印 "docs ok"，失败时逐条打印问题并以退出码 1 结束。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 行尾统一按 LF 处理：仓库在 Windows 上会被 core.autocrlf 检出成 CRLF，
// 而下面几条正则是按 `\n\n` / `^` 写的，不归一化会在干净检出上误报。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const problems = [];
const fail = (message) => problems.push(message);

/** 从一段文本里取出所有匹配的捕获组 1 */
function all(text, re) {
  return [...text.matchAll(re)].map((m) => m[1]);
}

// ── 1. 契约里的阶段与事件 ────────────────────────────────────────────
const contract = read('docs/CONTRACT.md');

const stagesBlock = contract.match(/export const STAGES = \[([\s\S]*?)\];/);
if (!stagesBlock) {
  fail('CONTRACT.md：找不到 `export const STAGES = [...]`');
} else {
  const stages = all(stagesBlock[1], /'([a-z]+)'/g);
  const EXPECTED_STAGES = 11;
  if (stages.length !== EXPECTED_STAGES) {
    fail(`CONTRACT.md：阶段应为 ${EXPECTED_STAGES} 个，实际 ${stages.length} 个（${stages.join(',')}）`);
  }
  for (const terminal of ['done', 'handoff', 'dropped']) {
    if (!stages.includes(terminal)) fail(`CONTRACT.md：缺少终态 ${terminal}`);
  }
}

const eventTable = contract.match(/\| event \|[\s\S]*?\n\n/);
if (!eventTable) {
  fail('CONTRACT.md：找不到事件表（以 `| event |` 开头）');
} else {
  const events = all(eventTable[0], /^\| `([a-z_]+)` \|/gm);
  const EXPECTED_EVENTS = 14;
  if (events.length !== EXPECTED_EVENTS) {
    fail(`CONTRACT.md：事件应为 ${EXPECTED_EVENTS} 个，实际 ${events.length} 个（${events.join(',')}）`);
  }
  // pick 归 plando_idea 管，不能同时是 transition 事件——两条路都能推进就等于没有唯一入口
  if (events.includes('pick')) fail('CONTRACT.md：pick 不能出现在事件表里（立项只走 plando_idea action=pick）');
}

// ── 2. 工具清单：PLAN.md 与 DEV-PROMPTS.md 必须一致且都是 8 个 ──────────
const plan = read('PLAN.md');
const prompts = read('docs/DEV-PROMPTS.md');
const apiFacts = read('docs/API-FACTS.md');

const toolsIn = (text) => [...new Set(all(text, /\b(plando_[a-z]+)\b/g))].sort();
const planTools = toolsIn(plan);
const promptTools = toolsIn(prompts);

if (planTools.length !== 8) fail(`PLAN.md：应出现 8 个 plando_ 工具，实际 ${planTools.length} 个（${planTools.join(',')}）`);
if (promptTools.length !== 8) fail(`DEV-PROMPTS.md：应出现 8 个 plando_ 工具，实际 ${promptTools.length} 个（${promptTools.join(',')}）`);
const missingInPrompts = planTools.filter((t) => !promptTools.includes(t));
if (missingInPrompts.length > 0) fail(`DEV-PROMPTS.md 缺少工具：${missingInPrompts.join(',')}`);

// ── 3. § 交叉引用必须指向真实存在的小节 ──────────────────────────────
const sectionsOf = (text) => new Set(all(text, /^#{2,3} ([0-9]+(?:\.[0-9]+)?)[ .、]/gm));

const contractSections = sectionsOf(contract);
const apiSections = sectionsOf(apiFacts);

for (const target of [prompts, apiFacts, contract]) {
  for (const match of target.matchAll(/(CONTRACT(?:\.md)?|API-FACTS(?:\.md)?) §([0-9]+(?:\.[0-9]+)?)/g)) {
    const [, docName, ref] = match;
    // 必须按「指向哪份文档」分别校验：两份文档都有 §5，混着查会让断掉的引用蒙混过关
    const known = docName.startsWith('CONTRACT') ? contractSections.has(ref) : apiSections.has(ref);
    if (!known) fail(`${docName} §${ref} 找不到对应小节`);
  }
}

// ── 4. 文档之间的相对链接必须指向真实文件 ────────────────────────────
// 直接遍历仓库里的全部 .md：新增文档自动纳入，不用回来改这张表。
const mdFiles = [];
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else if (entry.name.endsWith('.md')) mdFiles.push(rel);
  }
})(ROOT, '');

for (const name of mdFiles) {
  const text = read(name);
  const links = [...new Set(all(text, /\]\(([^)#\s]+\.md)\)/g))];
  for (const link of links) {
    const base = path.dirname(path.join(ROOT, name));
    const resolved = path.resolve(base, link);
    if (!fs.existsSync(resolved)) fail(`${name}：链接目标不存在 → ${link}`);
  }
}

// ── 5. DEV-PROMPTS 的轮次编号必须连续，且允许 R1a/R1b 这类拆分子轮 ──
// 规则：基础轮次从 R0 连续递增；同一基础轮次下的子轮次按 a、b、c… 连续。
const rounds = [...new Set(all(prompts, /^### (R[0-9]+[a-z]?) /gm))];
if (rounds.length === 0) {
  fail('DEV-PROMPTS.md：找不到任何 `### R<n> ...` 轮次标题');
} else {
  const groups = [];
  for (const round of rounds) {
    const [, base, sub = ''] = round.match(/^R([0-9]+)([a-z]?)$/);
    const last = groups[groups.length - 1];
    if (last && last.base === base) last.subs.push(sub);
    else groups.push({ base, subs: [sub] });
  }

  groups.forEach((group, index) => {
    if (group.base !== String(index)) {
      fail(`DEV-PROMPTS.md：基础轮次不连续，第 ${index + 1} 个是 R${group.base}，应为 R${index}`);
    }
    if (group.subs.length > 1) {
      const expectedSubs = group.subs.map((_, i) => String.fromCharCode(97 + i));
      if (group.subs.join(',') !== expectedSubs.join(',')) {
        fail(`DEV-PROMPTS.md：R${group.base} 的子轮次应为 ${expectedSubs.join(',')}，实际 ${group.subs.join(',')}`);
      }
    }
  });
}

// ── 输出 ─────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`docs check failed: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`docs ok: ${stagesBlock ? all(stagesBlock[1], /'([a-z]+)'/g).length : 0} stages, ${planTools.length} tools, ${rounds.length} rounds`);
