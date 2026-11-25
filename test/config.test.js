// test/config.test.js —— lib/config.js 的默认值 / 覆盖值 / 非法值。
//
// 约定：本文件不碰真实 ~/.plandoa（只在断言里比较字符串），不写任何文件。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { readConfig, DEFAULT_BUDGET } from '../lib/config.js';

test('缺省配置：dataRoot 落在 ~/.plando，budget 用契约默认值', () => {
  const cfg = readConfig({});
  assert.equal(cfg.dataRoot, path.join(os.homedir(), '.plando'));
  assert.deepEqual(cfg.budget, { mustUnderstand: 5, totalMinutes: 600 });
  assert.equal(cfg.autoCommit, false);
  assert.deepEqual(cfg.guardExtraDeny, []);
  // defaultProjectDir 必须在 dataRoot 之下，而不是撒在 home 根。
  assert.ok(cfg.defaultProjectDir.startsWith(cfg.dataRoot + path.sep));
});

test('readConfig() 不传参也等于全默认', () => {
  const cfg = readConfig();
  assert.deepEqual(cfg.budget, DEFAULT_BUDGET);
  assert.equal(cfg.autoCommit, false);
  assert.deepEqual(cfg.guardExtraDeny, []);
});

test('空字符串 dataRoot 视为缺省', () => {
  assert.equal(readConfig({ dataRoot: '' }).dataRoot, path.join(os.homedir(), '.plando'));
  assert.equal(readConfig({ dataRoot: '   ' }).dataRoot, path.join(os.homedir(), '.plando'));
});

test('覆盖值：相对路径 resolve 成绝对、budget 部分覆盖、deny 列表保留', () => {
  const cfg = readConfig({
    dataRoot: './tmp-data',
    defaultProjectDir: './tmp-projects',
    budget: { mustUnderstand: 2 },
    autoCommit: true,
    guardExtraDeny: ['custom_tool', ' other '],
  });
  assert.equal(cfg.dataRoot, path.resolve('./tmp-data'));
  assert.equal(cfg.defaultProjectDir, path.resolve('./tmp-projects'));
  // 只给一项时，另一项回落默认值。
  assert.deepEqual(cfg.budget, { mustUnderstand: 2, totalMinutes: 600 });
  assert.equal(cfg.autoCommit, true);
  assert.deepEqual(cfg.guardExtraDeny, ['custom_tool', 'other']);
});

test('字符串布尔：\'true\' → true，\'FALSE\' → false', () => {
  assert.equal(readConfig({ autoCommit: 'true' }).autoCommit, true);
  assert.equal(readConfig({ autoCommit: 'FALSE' }).autoCommit, false);
});

test('非法 budget.mustUnderstand（0 / 非整数 / 字符串）各抛中文错误', () => {
  for (const bad of [0, -1, 1.5, '5']) {
    assert.throws(() => readConfig({ budget: { mustUnderstand: bad } }), (err) => {
      assert.ok(err.message.startsWith('plando：配置'), `实际是：${err.message}`);
      assert.match(err.message, /mustUnderstand/);
      return true;
    }, `mustUnderstand=${JSON.stringify(bad)} 应该抛错`);
  }
});

test('非法 budget.totalMinutes 抛中文错误', () => {
  assert.throws(() => readConfig({ budget: { totalMinutes: -10 } }), (err) => {
    assert.match(err.message, /^plando：配置/);
    assert.match(err.message, /totalMinutes/);
    return true;
  });
});

test('budget 不是对象时抛错', () => {
  assert.throws(() => readConfig({ budget: 'big' }), /^Error: plando：配置 budget/);
});

for (const bad of ['yes', 2, {}, []]) {
  test(`非法 autoCommit ${JSON.stringify(bad)} 抛错`, () => {
    assert.throws(() => readConfig({ autoCommit: bad }), (err) => {
      assert.match(err.message, /^plando：配置 autoCommit/);
      return true;
    });
  });
}

test('非法 guardExtraDeny：不是数组 / 含非字符串', () => {
  assert.throws(() => readConfig({ guardExtraDeny: 'bash' }), /guardExtraDeny/);
  assert.throws(() => readConfig({ guardExtraDeny: ['bash', 42] }), /guardExtraDeny\[1\]/);
  assert.throws(() => readConfig({ guardExtraDeny: ['bash', '  '] }), /guardExtraDeny\[1\]/);
});

test('非法 dataRoot 类型抛错', () => {
  assert.throws(() => readConfig({ dataRoot: 123 }), /dataRoot/);
});

test('整体不是对象时抛错', () => {
  assert.throws(() => readConfig([]), /^Error: plando：配置/);
  assert.throws(() => readConfig('nope'), /^Error: plando：配置/);
});
