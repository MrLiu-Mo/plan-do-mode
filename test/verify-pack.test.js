// test/verify-pack.test.js —— 分发清单判定逻辑的单元测试。
//
// 不真跑 `npm pack`（慢，且依赖本机 npm）：verify-pack.mjs 把判断抽成了纯函数
// checkPackList / checkPackageMeta / collectExpected，这里直接喂构造出来的清单。
// 真跑 npm 的那一半由 `node scripts/verify-pack.mjs` 在 CI 里覆盖（PLAN §10.3 / A8）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Windows 上 import() 绝对路径必须先转 file:// URL（API-FACTS §5）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asUrl = (file) => pathToFileURL(file).href;

const pack = await import(asUrl(path.join(ROOT, 'scripts', 'verify-pack.mjs')));

const { checkPackList, checkPackageMeta, collectExpected } = pack;
const expected = collectExpected(ROOT);

/** 造一份「完全合格」的清单：所有必需文件都在，且混入零个禁止项。 */
function goodList() {
  return [
    'package.json',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'LICENSE',
    'locale/en.json',
    'locale/zh.json',
    ...expected.libFiles,
    ...expected.requiredFiles.filter((file) => file.startsWith('docs/')),
  ];
}

test('collectExpected 现读目录：lib 下每个 .js 都在期望清单里', () => {
  assert.ok(expected.libFiles.length >= 8, `lib/ 下至少应有 8 个模块，实际 ${expected.libFiles.length}`);
  for (const file of expected.libFiles) {
    assert.match(file, /^lib\/[a-z][a-z0-9-]*\.js$/, `lib 文件名不合规：${file}`);
  }
  // 关键：新增 lib 模块必须自动进期望清单，否则 veriify-pack 抓不到漏打包。
  assert.ok(expected.libFiles.includes('lib/index.js'), '期望清单必须含 lib/index.js');
  assert.ok(expected.libFiles.includes('lib/state.js'), '期望清单必须含 lib/state.js');
});

test('完整清单通过', () => {
  const result = checkPackList(goodList(), expected);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('少一个 lib 模块失败（新增模块漏进 files 白名单的典型场景）', () => {
  const list = goodList().filter((file) => file !== 'lib/state.js');
  const result = checkPackList(list, expected);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /lib\/state\.js/u);
  assert.match(result.problems[0], /缺少模块/u);
});

test('混进 test/ 失败', () => {
  const result = checkPackList([...goodList(), 'test/state.test.js'], expected);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('test/state.test.js')), result.problems.join('\n'));
});

test('内部审查报告不该进分发包（docs/REVIEW-*.md 有 150 KB 且行号会过期）', (t) => {
  // 仓库里确实有这类文件，否则这条测试是空转的。
  assert.ok(expected.excludedDocs.length > 0, '仓库里应有 docs/REVIEW-*.md');
  for (const file of expected.excludedDocs) {
    assert.match(file, /^docs\/REVIEW-.+\.md$/);
    // 它们不能同时出现在 requiredFiles 里——两处规则打架会让 verify-pack 自相矛盾。
    assert.equal(expected.requiredFiles.includes(file), false, `${file} 不该在 requiredFiles 里`);
  }

  const leaked = checkPackList([...goodList(), expected.excludedDocs[0]], expected);
  assert.equal(leaked.ok, false, '包里混进 REVIEW 报告必须报错');
  assert.ok(leaked.problems.some((p) => p.includes('不该被打包')), leaked.problems.join('\n'));
  assert.ok(leaked.problems.some((p) => p.includes('!docs/REVIEW-*.md')), '报错要指出修法：' + leaked.problems.join('\n'));
});

test('混进 scripts/ 失败', () => {
  const result = checkPackList([...goodList(), 'scripts/check-docs.mjs'], expected);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('scripts/check-docs.mjs')), result.problems.join('\n'));
});

test('混进 .git / .github / lock 文件失败', () => {
  const result = checkPackList([...goodList(), '.gitignore', '.github/workflows/test.yml', 'package-lock.json'], expected);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('.gitignore')), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p.includes('.github/workflows/test.yml')), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p.includes('package-lock.json')), result.problems.join('\n'));
});

test('少 locale 失败（本地 link 装看不出来，别人装完是空标题）', () => {
  const list = goodList().filter((file) => file !== 'locale/zh.json');
  const result = checkPackList(list, expected);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('locale/zh.json')), result.problems.join('\n'));
});

test('docs 缺一个 md 失败', () => {
  const docFile = expected.requiredFiles.find((file) => file.startsWith('docs/'));
  assert.ok(docFile, '期望清单里应有 docs/*.md');
  const list = goodList().filter((file) => file !== docFile);
  const result = checkPackList(list, expected);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes(docFile)), result.problems.join('\n'));
});

test('缺 cordis.patch.yml / icon.svg / LICENSE 都会失败', () => {
  for (const missing of ['cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md']) {
    const result = checkPackList(goodList().filter((file) => file !== missing), expected);
    assert.equal(result.ok, false, `${missing} 缺失时应当失败`);
    assert.ok(result.problems.some((p) => p.includes(missing)), result.problems.join('\n'));
  }
});

test('checkPackageMeta：真 package.json 通过', async () => {
  const fs = await import('node:fs');
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const result = checkPackageMeta(meta);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('checkPackageMeta：type / dsh.bundle.patch / files / description 缺失或错都会失败', () => {
  const base = { type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } }, files: ['lib'], description: '一句话' };
  assert.equal(checkPackageMeta(base).ok, true);

  assert.equal(checkPackageMeta({ ...base, type: 'commonjs' }).ok, false);
  assert.equal(checkPackageMeta({ ...base, dsh: { bundle: { patch: 'cordis.patch.yml' } } }).ok, false);
  assert.equal(checkPackageMeta({ ...base, dsh: undefined }).ok, false);
  assert.equal(checkPackageMeta({ ...base, files: [] }).ok, false);
  assert.equal(checkPackageMeta({ ...base, description: '  ' }).ok, false);
});
