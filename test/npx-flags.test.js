// test/npx-flags.test.js
//
// 「名单里的每一项无害」不能靠读名字判断，要靠一条**会让它失败的**测试。
// ——REVIEW-tools §16.11 第四条，这条测试就是给 `NPX_SAFE_FLAGS` 配的护栏。
//
// 背景（§16 R5 第二层）：`--no` 与 `--no-cache` 单看名字像「减少输出」，实测却会被 npm
// 当成「布尔取反前缀」，把后面的 token 当 npm 配置吃掉——
//   npx --no node --test   →  npm warn Unknown cli config "--test"，node 拿到空 argv，
//                             读空 stdin 立刻退出 0
// 于是「检查通过」而测试一行都没跑。两个开关已从名单里删掉，这条测试防止有人再按名字加回来。
//
// 判据很硬：**让子命令以非 0 退出，然后断言整条 npx 的退出码也是非 0**。
// 子命令被吞掉时 npx 自己会退出 0（它觉得没事可做），这就是可观测的失败。
//
// 为什么用真 spawn：这一层的风险恰恰是「我以为它无害」——mock 掉 npx 就永远发现不了。
// 每次 spawn 约 2 秒（npx 启动开销），7 个开关放在单独文件里由 `node --test` 并行跑，
// 不会拖慢整体。找不到 npx 时（精简环境）skip，不假装通过。
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCommand } from '../lib/checks.js';

/**
 * 名单的**探针**：这些写法能被 `validateCommand` 放行，说明它们还在 `NPX_SAFE_FLAGS` 里。
 * 刻意不 import 那个常量（它是模块内部实现，不是契约）；
 * 从外面探一遍反而更贴合「用户真能写出这些命令吗」这个问题。
 */
const ALLOWED_MIRROR = ['-y', '--yes', '--no-install', '-q', '--quiet', '-s', '--silent'];

/** 明确的「已被证实会吞掉子命令」的两个：必须是拒的。 */
const MUST_BE_REJECTED = ['--no', '--no-cache'];

function hasNpx() {
  const probe = spawnSync('npx --version', { shell: true, stdio: 'ignore', timeout: 30000, windowsHide: true });
  return probe.status === 0;
}

test('NPX_SAFE_FLAGS 的每一项都必须让子命令真的跑起来（§16.11 第四条）', (t) => {
  // 先确认探针和实现对得上——否则下面那圈真命令只是在测空气。
  for (const flag of ALLOWED_MIRROR) {
    assert.equal(validateCommand(`npx ${flag} node --test`), null,
      `「${flag}」应仍在放行名单里；如果它被删了，请同步删掉 ALLOWED_MIRROR 的这一项`);
  }
  if (!hasNpx()) return t.skip('这台机器上没有 npx，跳过真命令验证');
  for (const flag of ALLOWED_MIRROR) {
    // 子命令故意以 9 退出。npx 把这个退出码透传出来 → 证明确实跑到了子命令。
    // 一旦某个开关被 npm 当成配置吃掉，npx 会以 0 结束，这条断言就炸。
    const r = spawnSync(`npx ${flag} node -e "process.exit(9)"`, {
      shell: true, stdio: 'ignore', timeout: 90000, windowsHide: true,
    });
    assert.equal(
      r.status, 9,
      `「${flag}」让 npx 没有把退出码透传出来（实际 ${r.status}）——它很可能吞掉了子命令，`
      + '不能留在 NPX_SAFE_FLAGS 里',
    );
  }
});

test('已被证实会吞子命令的 --no / --no-cache 不在名单里（§16 R5）', (t) => {
  for (const flag of MUST_BE_REJECTED) {
    const bad = validateCommand(`npx ${flag} node --test`);
    assert.ok(bad, `「${flag}」必须被拒，否则「检查通过」而测试一行没跑：${flag}`);
  }
  // 佐证「为什么必须拒」：真跑一次，看它确实吞掉子命令并以 0 结束。
  if (!hasNpx()) return t.skip('这台机器上没有 npx，跳过真命令验证');
  for (const flag of MUST_BE_REJECTED) {
    const r = spawnSync(`npx ${flag} node -e "process.exit(9)"`, {
      shell: true, stdio: 'ignore', timeout: 90000, windowsHide: true,
    });
    assert.equal(r.status, 0, `「${flag}」预期会吞掉子命令并以 0 结束（实际 ${r.status}）——`
      + '如果这条变了，说明 npm 的行为改了，值得重新评估名单');
  }
});
