// test/readme.test.js —— 两份 README 的存在与互相指向。
//
// 为什么值得单独测：GitHub 首页只认仓库根目录的 `README.md`，而包内文档是给人看的第一手材料。
// 把中文版挪到 `README.zh.md` 之后，有三件事会**静默**坏掉：
//   1. `files` 白名单漏掉 `README.zh.md` → 装包的人只看到英文版，中文入口消失；
//   2. 两份之间的互链断掉 → 读者在两份文档间迷路，而 markdown 链接不会报错；
//   3. 有人改回「README.md 是中文」→ 国际访客在首页看到看不懂的内容。
// 三者都不会让 `node --test` 变红，除非在这里钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { collectExpected } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'verify-pack.mjs')).href);

const ENGLISH = 'README.md';
const CHINESE = 'README.zh.md';

/** 抽出 markdown 里指向另一份 README 的相对链接目标。 */
function linksTo(text, target) {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((href) => href === target);
}

test('两份 README 都在仓库根目录', () => {
  for (const rel of [ENGLISH, CHINESE]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少 ${rel}`);
  }
});

test('README.md 是英文的：除语言切换那一行外没有汉字', () => {
  const text = read(ENGLISH);
  // 语言切换行必须写成中文标签（[中文版 README]），那是唯一允许出现汉字的地方。
  const switcher = text.split('\n').find((line) => line.includes(`](${CHINESE})`));
  assert.ok(switcher, `README.md 里应有指向 ${CHINESE} 的语言切换链接`);

  const withoutSwitcher = text.split('\n').filter((line) => line !== switcher).join('\n');
  const han = withoutSwitcher.match(/[\u4e00-\u9fff]/g) || [];
  assert.deepEqual(
    han,
    [],
    `README.md 里还有汉字（${[...new Set(han)].join('')}）——英文版要能整篇读下来，中文内容去 ${CHINESE}`,
  );
});

test('README.zh.md 是中文的：含足量汉字，且不是英文版的副本', () => {
  const text = read(CHINESE);
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  assert.ok(han > 500, `README.zh.md 汉字只有 ${han} 个，看起来不是中文版`);
  assert.notEqual(text.trim(), read(ENGLISH).trim(), '两份 README 内容相同——语言版没起到作用');
});

test('两份 README 互相链接（断链不会报错，所以在这里钉住）', () => {
  assert.equal(linksTo(read(ENGLISH), CHINESE).length, 1, `README.md 应恰好链到 ${CHINESE} 一次`);
  assert.equal(linksTo(read(CHINESE), ENGLISH).length, 1, `${CHINESE} 应恰好链回 ${ENGLISH} 一次`);
});

test('两份 README 都在分发包白名单里（漏了中文版，装包的人就只剩英文）', () => {
  const meta = JSON.parse(read('package.json'));
  for (const rel of [ENGLISH, CHINESE]) {
    assert.ok(meta.files.includes(rel), `package.json 的 files 缺 ${rel}`);
  }
  const expected = collectExpected(ROOT);
  for (const rel of [ENGLISH, CHINESE]) {
    assert.ok(expected.requiredFiles.includes(rel), `verify-pack 的 requiredFiles 缺 ${rel}`);
  }
});

test('渠道横幅在 README.md 里要能指到真实的 release', () => {
  // 英文版是 GitHub 首页；它的下载命令必须指向真实仓库而不是占位符，
  // 否则第一个照抄的人就卡住。占位符扫描在 release-check，这里只查「指向真地址」。
  const text = read(ENGLISH);
  assert.match(text, /https:\/\/github\.com\/MrLiu-Mo\/plan-do-mode\/releases\/download\/v0\.1\.0\/dsh-plan-do-0\.1\.0\.tgz/);
  assert.equal(/<owner>|<your[-_ ]?name>/.test(text), false, 'README.md 里不该再有仓库占位符');
});
