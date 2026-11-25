// test/checks.test.js —— lib/checks.js：命令白名单、声明、只跑已声明命令、退出码、截断、原子写。
// 全部在 fs.mkdtempSync(os.tmpdir()) 出来的临时目录里跑，测完删掉；绝不碰真实项目。
//
// 注意：这里**不能**用 `node -e '…'` 造测试命令——`-e` 正是 REVIEW-tools G1 要拦的东西
// （它把「跑一个检查」变成「执行任意代码」）。所以统一写成「真实脚本文件 + node 文件名」，
// 这也正是用户会写的那种检查命令。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declareCheck, readChecks, runCheck, validateCommand, checksPath,
  ALLOWED_COMMANDS, MAX_OUTPUT_BYTES, MAX_COMMAND_LENGTH,
} from '../lib/checks.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plando-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 在临时目录里落一个脚本，返回「node 脚本名」这样的检查命令。 */
function script(dir, name, code) {
  fs.writeFileSync(path.join(dir, name), code, 'utf8');
  return `node ${name}`;
}

test('readChecks：文件不存在返回 {}；declareCheck 写到 .plando/checks.json', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readChecks(dir), {});
  const cmd = script(dir, 'ok.mjs', 'process.exit(0)\n');
  const r = declareCheck(dir, { id: 'c1' }, cmd);
  assert.equal(r.ok, true, r.reason);
  const file = checksPath(dir);
  assert.equal(file, path.join(fs.realpathSync(dir), '.plando', 'checks.json'), '路径按绝对路径拼接');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false, '临时文件必须已经 rename 掉');
  const all = readChecks(dir);
  assert.equal(all.c1.command, cmd);
  assert.equal(typeof all.c1.at, 'string');
});

test('validateCommand：放行普通测试命令', () => {
  for (const cmd of [
    'node --test', 'npm test', 'npm run lint', 'pnpm vitest run', 'python -m pytest',
    'cargo test', 'go test ./...', 'npx tsc --noEmit', 'node scripts/check-docs.mjs',
    'node --test test/a.test.js', 'eslint src', 'pytest -q',
  ]) {
    assert.equal(validateCommand(cmd), null, `应放行：${cmd}`);
  }
});

test('validateCommand：拒绝内联执行（-e / --eval / -c），含贴值形式', () => {
  for (const cmd of [
    "node -e 'console.log(1)'",
    'node --eval "x"',
    'node -p "1+1"',
    "python -c 'print(1)'",
    "python3 -c 'print(1)'",
    "deno eval 'x'",
    // 贴值形式：只比对字符串相等会全放过（REVIEW-tools §8.2/§8.3 实测可执行任意代码）。
    'node -e1+1',
    'node -e=1',
    'node --eval=1+1',
    'node --print=1+1',
    'node -p1+1',
  ]) {
    const bad = validateCommand(cmd);
    assert.ok(bad, `必须拒绝：${cmd}`);
    assert.match(bad, /任意代码|-e|--eval|-c/, `理由要能看懂：${cmd} → ${bad}`);
  }
});

test('validateCommand：拒绝用 -r / --require / --import 加载任意模块', () => {
  for (const cmd of [
    'node -r ./x.cjs --test',
    'node -r./x.cjs --test',
    'node --require ./x.cjs --test',
    'node --require=./x.cjs --test',
    'node --import=./x.mjs --test',
    'node --loader=./x.mjs --test',
    'node --experimental-loader=./x.mjs --test',
  ]) {
    const bad = validateCommand(cmd);
    assert.ok(bad, `必须拒绝：${cmd}`);
    assert.match(bad, /任意代码/, `理由要能看懂：${cmd} → ${bad}`);
  }
});

test('validateCommand：包管理器只许跑脚本，不许安装 / 执行任意包', () => {
  for (const cmd of [
    'npm install', 'npm i', 'npm ci', 'npm add left-pad',
    'npm exec evil', 'npm x evil', 'pnpm exec evil', 'pnpm dlx evil',
    'npx evil', 'npx --yes evil', 'npx some-package@latest',
    'npm run postinstall', 'npm run prepare', 'npm run-script evil',
  ]) {
    assert.ok(validateCommand(cmd), `必须拒绝：${cmd}`);
  }
  // 正常跑测试 / 本地已装工具要放行。
  for (const cmd of ['npm test', 'npm run build', 'pnpm vitest run', 'npx tsc --noEmit', 'yarn test']) {
    assert.equal(validateCommand(cmd), null, `必须放行：${cmd}`);
  }
});

test('validateCommand：拒绝「子命令本身就是执行代码」的形态（§8.7 ④）', () => {
  for (const cmd of [
    'pip install x', 'pip download x',
    'python -m pip install .', 'python -m http.server',
    'uv pip install x', 'uv run pytest',
    'cargo run', 'cargo install cargo-watch',
    'go run ./x.go', 'go generate ./...',
    'dotnet run', 'mvn exec:java', 'gradle run',
    'java -jar x.jar',
  ]) {
    assert.ok(validateCommand(cmd), `必须拒绝：${cmd}`);
  }
  // 只跑测试/构建的形态照旧放行。
  for (const cmd of ['cargo test', 'cargo build', 'go test ./...', 'dotnet test', 'python -m pytest', 'python -m unittest discover']) {
    assert.equal(validateCommand(cmd), null, `必须放行：${cmd}`);
  }
});

test('validateCommand：拒绝 shell 与带路径的可执行文件', () => {
  for (const cmd of ['cmd /c "echo x"', 'powershell -Command "x"', 'pwsh -c x', 'bash -c x', 'sh -c x']) {
    assert.ok(validateCommand(cmd), `必须拒绝 shell：${cmd}`);
  }
  for (const cmd of ['./node x.js', 'C:\\Windows\\System32\\cmd.exe /c x', '/usr/bin/node x.js', '..\\node x.js']) {
    assert.ok(validateCommand(cmd), `必须拒绝带路径的命令：${cmd}`);
  }
});

test('validateCommand：不在白名单的程序一律拒绝（黑名单不可靠）', () => {
  for (const cmd of ['curl http://x', 'wget x', 'rm -rf build', 'del a.txt', 'cp a b', 'git checkout .']) {
    const bad = validateCommand(cmd);
    assert.ok(bad, `必须拒绝：${cmd}`);
    assert.match(bad, /不在允许的检查命令里/, `理由应说明白名单：${cmd} → ${bad}`);
  }
  // 白名单本身是数据，测试防止它被悄悄放宽成「什么都能跑」
  assert.ok(ALLOWED_COMMANDS.includes('node'));
  assert.equal(ALLOWED_COMMANDS.includes('cmd'), false);
  assert.equal(ALLOWED_COMMANDS.includes('powershell'), false);
});

test('validateCommand：node -c 是语法检查，不该被 -c 规则误伤', () => {
  // `node -c` 在 node 上不是语法检查（那是 --check），所以按危险参数处理是对的；
  // 这条用例锁住「我们没把普通短参数一律拒掉」这个平衡点。
  assert.equal(validateCommand('node --test --test-name-pattern foo'), null);
  assert.equal(validateCommand('npm test -- --coverage'), null);
});

test('declareCheck：危险命令被拒且不写文件', (t) => {
  const dir = tmpDir(t);
  const r = declareCheck(dir, { id: 'c1' }, "node -e 'require(\"node:fs\").writeFileSync(\"x\",\"y\")'");
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plando：/);
  assert.match(r.reason, /——下一步：/);
  assert.equal(fs.existsSync(checksPath(dir)), false, '被拒时不该落盘');
});

test('declareCheck：空命令 / 超长 / 缺卡 id / 缺 dir 都被拒，且不写文件', (t) => {
  const dir = tmpDir(t);
  assert.equal(declareCheck(dir, { id: 'c1' }, '').ok, false);
  assert.equal(declareCheck(dir, { id: 'c1' }, '   ').ok, false);
  const tooLong = `node ${'x'.repeat(MAX_COMMAND_LENGTH)}`;
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
  const pass = script(dir, 'pass.mjs', 'process.exit(0)\n');
  const fail = script(dir, 'fail.mjs', 'process.exit(1)\n');
  assert.equal(declareCheck(dir, { id: 'c1' }, pass).ok, true);
  assert.equal(declareCheck(dir, { id: 'c1' }, fail).ok, true);
  assert.equal(declareCheck(dir, 'c2', pass).ok, true);
  const all = readChecks(dir);
  assert.deepEqual(Object.keys(all).sort(), ['c1', 'c2']);
  assert.equal(all.c1.command, fail);
});

test('validateCommand：`npm --version` / `--help` 这类只问信息的调用放行', () => {
  for (const cmd of ['npm --version', 'npm -v', 'npm --help', 'pnpm --version']) {
    assert.equal(validateCommand(cmd), null, `必须放行：${cmd}`);
  }
  // 但「开关后面的子命令」不能因此蒙混过关。
  for (const cmd of ['npm --silent install x', 'npm --if-present run postinstall']) {
    assert.ok(validateCommand(cmd), `必须拒绝：${cmd}`);
  }
});

test('runCheck：npm 脚本在 Windows 上也能跑（不能直接 spawn npm / npm.cmd）', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), "import test from 'node:test';\ntest('ok', () => {});\n", 'utf8');

  const declared = declareCheck(dir, { id: 'c1' }, 'npm test');
  assert.equal(declared.ok, true, declared.reason);
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, true, `npm test 应能跑通（Windows 上走 npm-cli.js 而不是 npm.cmd）：${r.reason}`);
  assert.equal(r.exitCode, 0);
  // 测试运行器的输出在 stdout/stderr 之间会因 npm 版本而异，两路合并看即可。
  assert.match(`${r.stdout}${r.stderr}`, /test|pass/, '应看到脚本被真的执行了');
});

test('runCheck：退出码 0 → ok:true，exitCode 0', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c1' }, script(dir, 'ok.mjs', 'process.exit(0)\n'));
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('runCheck：非零退出码不抛错，返回 ok:false + 真实 exitCode', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c3' }, script(dir, 'exit3.mjs', 'process.exit(3)\n'));
  const r = runCheck(dir, 'c3');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.reason, /退出码 3/);
  assert.match(r.reason, /——下一步：/);
});

test('runCheck：stdout / stderr 都能拿到', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'c1' }, script(dir, 'both.mjs', 'console.log("out");console.error("err")\n'));
  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
});

test('runCheck：未声明的命令被拒且绝不执行（用「会创建文件」的脚本验证真没跑）', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'should-not-exist.txt');
  const cmd = script(dir, 'touch.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
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

test('runCheck：手改进 checks.json 的危险命令在执行前被拦（不能把旧声明当永久授权）', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'injected.txt');
  const evil = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},"x")'`;
  fs.mkdirSync(path.join(dir, '.plando'), { recursive: true });
  fs.writeFileSync(checksPath(dir), JSON.stringify({ c1: { command: evil, at: '' } }), 'utf8');

  const r = runCheck(dir, 'c1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /不安全/);
  assert.equal(fs.existsSync(marker), false, '手改进来的危险命令绝不能被执行');
});

test('runCheck：shell:false —— 命令里的 && 不会被当成 shell 连接符', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'shell-injection.txt');
  script(dir, 'ok.mjs', 'process.exit(0)\n');
  script(dir, 'touch.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  const cmd = 'node ok.mjs && node touch.mjs';
  assert.equal(declareCheck(dir, { id: 'c9' }, cmd).ok, true);
  const r = runCheck(dir, 'c9');
  assert.equal(fs.existsSync(marker), false, '&& 右半段绝不能被执行');
  assert.equal(r.exitCode, 0, '左半段正常退出，右半段只是多余参数');
});

test('runCheck：超长输出截断到 8KB 并带说明', (t) => {
  const dir = tmpDir(t);
  declareCheck(dir, { id: 'big' }, script(dir, 'big.mjs', 'process.stdout.write("x".repeat(20000))\n'));
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
