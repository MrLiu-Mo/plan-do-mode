// test/release-check.test.js —— 「能不能发出去」的判定逻辑。
//
// `node --test` 管代码对不对，`verify-pack` 管清单全不全，「发布准备度」是第三件事：
// 元数据填了没、文档里还有没有 `<owner>` 占位、工作区干净不干净。
// 把它塞进 `node --test` 会让开发期天天红（本仓库开发期一直有未提交改动），
// 所以那条命令是手动跑的；但它的**判定逻辑**必须被测到——否则发布那天才发现它自己有 bug。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkRelease } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'release-check.mjs')).href);

/** 一份「完全可发布」的元数据。用例逐个弄坏它。 */
function goodMeta(over = {}) {
  return {
    name: 'dsh-plan-do',
    version: '0.1.0',
    description: '一句话说明',
    license: 'MIT',
    keywords: ['dsh-plugin', 'dsh-bundle'],
    repository: { type: 'git', url: 'git+https://github.com/someone/plan-do-mode.git' },
    homepage: 'https://github.com/someone/plan-do-mode#readme',
    bugs: { url: 'https://github.com/someone/plan-do-mode/issues' },
    icon: './icon.svg',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...over,
  };
}

const goodDocs = {
  'README.md': '装：add -w "https://github.com/someone/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"',
  'PLAN.md': '同上',
  'docs/INSTALL.md': '同上',
};
const cleanEnv = { gitStatus: '', headTag: 'v0.1.0' };

test('checkRelease：合格的元数据 + 干净工作区 → 零阻塞', () => {
  const { blockers } = checkRelease(goodMeta(), goodDocs, cleanEnv);
  assert.deepEqual(blockers, []);
});

test('checkRelease：缺 repository / homepage / bugs / icon 都算阻塞', () => {
  for (const key of ['repository', 'homepage', 'bugs', 'icon']) {
    const { blockers } = checkRelease(goodMeta({ [key]: undefined }), goodDocs, cleanEnv);
    assert.ok(
      blockers.some((b) => b.includes(key)),
      `缺 ${key} 应报阻塞，实际：${blockers.join(' | ')}`,
    );
  }
});

test('checkRelease：元数据里还挂着占位符算阻塞', () => {
  const { blockers } = checkRelease(goodMeta({ repository: { url: 'https://github.com/<owner>/plan-do-mode' } }), goodDocs, cleanEnv);
  assert.ok(blockers.some((b) => b.includes('占位符')), blockers.join('\n'));
});

test('checkRelease：文档里还挂着 <owner> 算阻塞，并指出行号', () => {
  const docs = { ...goodDocs, 'README.md': '第一行\n第二行 https://github.com/<owner>/plan-do-mode/releases\n' };
  const { blockers } = checkRelease(goodMeta(), docs, cleanEnv);
  const hit = blockers.find((b) => b.includes('README.md'));
  assert.ok(hit, `应报 README.md 有占位符：${blockers.join('\n')}`);
  assert.match(hit, /第 2 行/, '要指出具体行号，否则在长文档里找不着');
});

test('checkRelease：version 不是合法 semver 算阻塞', () => {
  for (const version of ['0.1', 'v0.1.0', '', undefined]) {
    const { blockers } = checkRelease(goodMeta({ version }), goodDocs, cleanEnv);
    assert.ok(blockers.some((b) => b.includes('semver')), `${version} 应报错：${blockers.join(' | ')}`);
  }
});

test('checkRelease：keywords 缺 dsh-plugin 算阻塞（索引靠它发现）', () => {
  const { blockers } = checkRelease(goodMeta({ keywords: ['dsh-bundle'] }), goodDocs, cleanEnv);
  assert.ok(blockers.some((b) => b.includes('dsh-plugin')), blockers.join('\n'));
});

test('checkRelease：dsh.bundle.patch 不对算阻塞', () => {
  const { blockers } = checkRelease(goodMeta({ dsh: { bundle: { patch: 'cordis.patch.yml' } } }), goodDocs, cleanEnv);
  assert.ok(blockers.some((b) => b.includes('cordis.patch.yml')), blockers.join('\n'));
});

test('checkRelease：工作区不干净算阻塞，且报出改动文件', () => {
  const { blockers } = checkRelease(goodMeta(), goodDocs, { gitStatus: ' M lib/checks.js\n?? docs/NEW.md\n' });
  const hit = blockers.find((b) => b.includes('未提交'));
  assert.ok(hit, blockers.join('\n'));
  assert.match(hit, /2 个/, '要报出改动数量');
  assert.match(hit, /lib\/checks\.js/, '要报出具体文件');
});

test('checkRelease：tgz 文件名与版本对不上只是建议，不阻塞', () => {
  const docs = { ...goodDocs, 'README.md': 'add dsh-plan-do-0.0.9.tgz' };
  const { blockers, suggestions } = checkRelease(goodMeta(), docs, cleanEnv);
  assert.deepEqual(blockers, [], '版本号不一致不该阻塞发布（可能只是文档滞后）');
  assert.ok(suggestions.some((s) => s.includes('dsh-plan-do-0.0.9.tgz')), suggestions.join('\n'));
});

test('checkRelease：docs/RELEASE.md 不参与占位符扫描（它本身就要写出占位符长什么样）', () => {
  const docs = { ...goodDocs, 'docs/RELEASE.md': '把 `github.com/<owner>/plan-do-mode` 换成真实仓库' };
  const { blockers } = checkRelease(goodMeta(), docs, cleanEnv);
  assert.deepEqual(blockers, [], 'RELEASE.md 是换占位符的说明书，扫它必然误报');
});

// 第一版把占位符判据写成「出现 <owner> 这几个字」的纯字面量匹配，于是**说明性文字**也被判成阻塞项：
// `docs/INSTALL.md` 里那句「文档里还有 <owner> 吗」让发布检查自己红了一条，
// 而它想拦的其实是「还指向假仓库的网址」。判据改成要求占位符紧挨 URL 上下文。
test('checkRelease：只是提到占位符字样的说明文字不算阻塞', () => {
  const docs = {
    ...goodDocs,
    'docs/INSTALL.md': '它现在**是红的**——仓库地址还没定。等你把 `<owner>` 换成真实值再看。',
  };
  const { blockers } = checkRelease(goodMeta(), docs, cleanEnv);
  assert.deepEqual(blockers, [], `解释「怎么换占位符」的正文不该算没改完：${blockers.join(' | ')}`);
});

test('checkRelease：真正指向假仓库的网址仍要报出来（正文解释不能把检查弄瞎）', () => {
  for (const bad of [
    'add -w "https://github.com/<owner>/plan-do-mode/releases/download/v0.1.0/x.tgz"',
    'git+https://github.com/<your-name>/plan-do-mode.git',
    '见 https://example.com/plan-do-mode',
  ]) {
    const { blockers } = checkRelease(goodMeta(), { ...goodDocs, 'README.md': bad }, cleanEnv);
    assert.ok(blockers.some((b) => b.includes('README.md')), `真实占位网址必须报：${bad} → ${blockers.join(' | ')}`);
  }
});

test('checkRelease：仓库对象缺 url 算阻塞', () => {
  const { blockers } = checkRelease(goodMeta({ repository: { type: 'git' } }), goodDocs, cleanEnv);
  assert.ok(blockers.some((b) => b.includes('repository')), blockers.join('\n'));
});

test('真 package.json 现在是「零阻塞」的（占位符已换成真实仓库）', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { blockers } = checkRelease(meta, {
    'README.md': fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
    'PLAN.md': fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8'),
    'docs/INSTALL.md': fs.readFileSync(path.join(ROOT, 'docs', 'INSTALL.md'), 'utf8'),
  }, { gitStatus: '', headTag: 'v0.1.0' });
  // 2026-11-25 仓库建好（github.com/MrLiu-Mo/plan-do-mode），元数据与文档链接都换成了真值，
  // 所以这条从「断言有阻塞」翻成「断言零阻塞」——它就是那条绊线，翻面了。
  assert.deepEqual(blockers, [], `发布元数据应当齐了：${blockers.join(' | ')}`);
  assert.equal(meta.repository.url, 'git+https://github.com/MrLiu-Mo/plan-do-mode.git');
  assert.equal(meta.homepage, 'https://github.com/MrLiu-Mo/plan-do-mode#readme');
  assert.equal(meta.bugs.url, 'https://github.com/MrLiu-Mo/plan-do-mode/issues');
  assert.equal(meta.icon, './icon.svg');
});
