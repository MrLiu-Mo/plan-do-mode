// test/checks.test.js —— lib/checks.js：声明、只跑已声明命令、退出码、截断、原子写。
// 全部在 fs.mkdtempSync(os.tmpdir()) 出来的临时目录里跑，测完删掉；绝不碰真实项目。
// 命令一律用 `node -e "…"` 这类无害命令。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declareCheck, readChecks, runCheck, checksPath, MAX_OUTPUT_BYTES, MAX_COMMAND_LENGTH,
} from '../lib/checks.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 用 node -e 包一层，避免依赖外部命令是否存在。
// 外层用单引号：里面可以自由写双引号字符串，且不经过 shell（shell:false）。
const js = (code) => `node -e '${code}'`;

test('readChecks：文件不存在返回 {}；declareCheck 写到 .plando/checks.json', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readChecks(dir), {});
  const r = declareCheck(dir, { id: 'c1' }, js('process.exit(0)'));
  assert.equal(r.ok, true, r.reason);
  const file = checksPath(dir);
  assert.equal(file, path.join(fs.realpathSync(dir), '.plando', 'checks.json'), '路径按绝对路径拼接');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false, '临时文件必须已经 rename 掉');
  const all = readChecks(dir);
  assert.equal(all.c1.command, js('process.exit(0)'));
  assert.equal(typeof all.c1.at, 'string');
});

test('declareCheck：空命令 / 超长 / 缺卡 id / 缺 dir 都被拒，且不写文件', (t) => {
  const dir = tmpDir(t);
  assert.equal(declareCheck(dir, { id: 'c1' }, '').ok, false);
  assert.equal(declareCheck(dir, { id: 'c1' }, '   ').ok, false);
  const tooLong = `node -e "${'x'.repeat(MAX_COMMAND_LENGTH)}"`;
  const r = declareCheck(dir, { id: 'c1' }, tooLong);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /——下一步：/);
  assert.equal(declareCheck(dir, '', 'node -v').ok, false);
  assert.equal(declareCheck('', { id: 'c1' }, 'node -v').ok, false);
  assert.equal(fs.existsSync(checksPath(dir)), false, '被拒时不该落盘');
});

test('declareCheck：同一张卡重复声明覆盖旧命令；多张卡各自独立', (t) => {
  const dir = tmpDir(t);
  assert.equal(declareCheck(dir, { id: 'c1' }, js('process.exit(0)')).ok, true);
  assert.equal(declareCheck(dir, { id: 'c1' }, js('process.exit(1)')).ok, true);
  assert.equal(declareCheck(dir, 'c2', js('process.exit(0)')).ok, true);
  const all = readChecks(dir);
  assert.deepEqual(Object.keys(all).sort(), ['c1', 'c2']);
  assert.equal(all.c1.command, js('process.exit(1)'));
});

test('runCheck：退出码 0 → ok:true，exitCode 0', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c1' }, js('process.exit(0)'));
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('runCheck：非零退出码不抛错，返回 ok:false + 真实 exitCode', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c3' }, js('process.exit(3)'));
  const r = runCheck(dir, 'c3');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.reason, /退出码 3/);
  assert.match(r.reason, /——下一步：/);
});

test('runCheck：stdout / stderr 都能拿到', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c1' }, js('console.log("out");console.error("err")'));
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
});

test('runCheck：未声明的命令被拒且绝不执行（用「会创建文件」的命令验证真没跑）', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'should-not-exist.txt');
  // 已声明的命令会创建文件：先证明它确实会创建，再证明跑未声明名字时它没被执行。
  const cmd = js(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"x")`);
  assert.equal(declareCheck(dir, { id: 'c1' }, cmd).ok, true);

  const r = runCheck(dir, 'c2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有在 checks\.json 里声明/);
  assert.equal(fs.existsSync(marker), false, '未声明的检查绝不能被顺带执行');

  // 反向对照：声明的那条确实会创建文件，说明上面的「不存在」是真没跑，不是命令无效。
  const ran = runCheck(dir, 'c1');
  assert.equal(ran.ok, true, ran.reason);
  assert.equal(fs.existsSync(marker), true, '已声明命令应当真的执行了');
});

test('runCheck：完全没有 checks.json 时也拒绝且不执行', (t) => {
  const dir = tmpDir(t);
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(checksPath(dir)), false);
});

test('runCheck：shell:false —— 命令里的 && 不会被当成 shell 连接符', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'shell-injection.txt');
  // 若经过 shell，`&&` 之后的 node 会真的执行并创建文件；shell:false 下它只是 argv 的一部分。
  const cmd = `${js('process.exit(0)')} && ${js(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"x")`)}`;
  assert.equal(declareCheck(dir, { id: 'c9' }, cmd).ok, true);
  const r = runCheck(dir, 'c9');
  assert.equal(fs.existsSync(marker), false, '&& 右半段绝不能被执行');
  // 半段命令没有真跑，退出码不是 3
  assert.notEqual(r.exitCode, 3);
});

test('runCheck：超长输出截断到 8KB 并带说明', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'big' }, js('process.stdout.write("x".repeat(20000))'));
  const r = runCheck(dir, 'big');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.exitCode, 0);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 20000, '必须真的截断');
  assert.match(r.stdout, /输出已截断/);
  assert.ok(r.stdout.startsWith('x'.repeat(100)), '保留开头内容');
  // 截断后的正文不超过上限 + 说明行
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= MAX_OUTPUT_BYTES + 200);
});

test('runCheck：checks.json 损坏时不执行，返回 plando 形状的错误', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, '.plando'), { recursive: true });
  fs.writeFileSync(checksPath(dir), '{ 不是 json', 'utf8');
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /——下一步：/);
});
