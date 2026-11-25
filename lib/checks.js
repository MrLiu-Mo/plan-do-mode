// lib/checks.js
// 卡片检查命令：声明（写 .plando/checks.json）与执行（只跑已声明的命令）。
// 契约来源：PLAN §3/§四（plando_check 只运行已声明命令）、docs/CONTRACT.md §5（错误消息形状）。
// 硬约束：
//   - 零依赖：只 import node: 内置模块。
//   - 只运行 checks.json 里已声明的命令；未声明一律拒绝，绝不执行。
//   - spawnSync + shell:false（命令不经过 shell 解析，`;` `&&` 之类不会被执行）。
//   - 写 checks.json 走 .tmp + rename 原子替换（CONTRACT §4 的写盘规则）。
//   - stdout/stderr 各截断到 8KB，避免把整页日志塞回模型上下文。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 命令长度上限（字符数）。 */
export const MAX_COMMAND_LENGTH = 500;
/** 单条输出（stdout / stderr 各算）的截断上限。 */
export const MAX_OUTPUT_BYTES = 8 * 1024;
/** 检查命令默认超时：60 秒（PLAN §四）。 */
export const CHECK_TIMEOUT_MS = 60 * 1000;

const CHECKS_FILE = 'checks.json';

// §5 错误消息：`plando：<现在在哪>，<为什么不行>——下一步：<做什么>`。
function reason(why, next) {
  const head = '现在是「边做边学」阶段，';
  const tail = `——下一步：${next}`;
  const budget = 160 - 6 /* plando： */ - [...head].length - [...tail].length;
  const chars = [...String(why)];
  const whyText = chars.length <= budget ? String(why) : chars.slice(0, Math.max(budget - 1, 0)).join('') + '。';
  return `plando：${head}${whyText}${tail}`;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** checks.json 的绝对路径：<dir>/.plando/checks.json。 */
export function checksPath(dir) {
  return path.join(path.resolve(dir), '.plando', CHECKS_FILE);
}

// 原子写 JSON：先写 <file>.tmp 再 rename 覆盖，半写文件比报错更糟。
function atomicWriteJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** readChecks(dir) -> object；文件不存在返回 {}。JSON 损坏时抛 plando 形状的错误。 */
export function readChecks(dir) {
  const file = checksPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(reason(`checks.json 不是合法 JSON（${err.message}）`, '备份该文件后人工修回，或删掉它重新用 plando_card 声明检查'));
  }
  return isPlainObject(parsed) ? parsed : {};
}

/** 从 card（对象或 id 字符串）取出卡 id。 */
function cardIdOf(card) {
  if (isNonEmptyString(card)) return card;
  if (isPlainObject(card) && isNonEmptyString(card.id)) return card.id;
  return '';
}

/**
 * declareCheck(dir, card, command) -> { ok, reason? }
 * 把检查命令记到 <dir>/.plando/checks.json，键为卡 id；重复声明覆盖旧命令。
 */
export function declareCheck(dir, card, command) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, reason: reason('不知道该写哪个项目目录', '先调 plando_project action=open，拿项目 dir 后再声明检查') };
  }
  const id = cardIdOf(card);
  if (!id) {
    return { ok: false, reason: reason('checks 的键必须是卡片 id', '先传卡 id（如 c1）再声明检查命令') };
  }
  if (!isNonEmptyString(command)) {
    return { ok: false, reason: reason(`卡片 ${id} 的检查命令为空`, '写一条可直接执行的命令（如 node --test）后重传') };
  }
  if ([...command].length > MAX_COMMAND_LENGTH) {
    return { ok: false, reason: reason(`检查命令超过 ${MAX_COMMAND_LENGTH} 字上限`, '把检查拆成多条短命令，或写进 package.json scripts 再调用') };
  }
  const all = readChecks(dir);
  all[id] = { command, at: new Date().toISOString() };
  atomicWriteJson(checksPath(dir), all);
  return { ok: true };
}

// 把命令字符串切成 argv：支持单引号 / 双引号 / 反斜杠转义，不做变量展开和管道。
// 这样配合 shell:false，`echo a && rm -rf /` 里的 `&&` 只会被当成普通参数。
function tokenize(command) {
  const tokens = [];
  let buf = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) buf += command[++i];
      else buf += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) tokens.push(buf);
      buf = '';
      has = false;
    } else {
      buf += ch;
      has = true;
    }
  }
  if (has) tokens.push(buf);
  return tokens;
}

// 按字节截断（不切坏多字节字符由 Buffer 处理），超长时补一句说明。
function truncate(text) {
  const str = typeof text === 'string' ? text : '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= MAX_OUTPUT_BYTES) return { text: str, truncated: false };
  return {
    text: `${buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n…（输出已截断，原长 ${buf.length} 字节，只保留前 ${MAX_OUTPUT_BYTES} 字节）`,
    truncated: true,
  };
}

/**
 * runCheck(dir, name) -> { ok, exitCode, stdout, stderr, reason? }
 * name 是卡片 id（checks.json 的键）。只执行已声明的命令；未声明 → ok:false 且绝不执行。
 */
export function runCheck(dir, name) {
  if (!isNonEmptyString(dir)) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: reason('不知道该在哪个项目目录跑检查', '先调 plando_project action=open，拿项目 dir 后再跑检查') };
  }
  let all;
  try {
    all = readChecks(dir);
  } catch (err) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: String((err && err.message) || err) };
  }
  const entry = isNonEmptyString(name) ? all[name] : undefined;
  const command = isPlainObject(entry) ? entry.command : typeof entry === 'string' ? entry : '';
  if (!isNonEmptyString(command)) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: reason(`检查 ${String(name)} 没有在 checks.json 里声明，不会执行任何命令`, '先用 plando_card 声明这张卡的检查命令（plando_check action=declare），再跑检查'),
    };
  }

  const argv = tokenize(command);
  if (argv.length === 0) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', reason: reason(`检查 ${name} 的命令解析不出可执行文件`, '改写成「可执行文件 参数…」的形式后重新声明') };
  }
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: path.resolve(dir),
    shell: false,
    timeout: CHECK_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });

  const out = truncate(result.stdout);
  const errOut = truncate(result.stderr);
  const base = { exitCode: typeof result.status === 'number' ? result.status : null, stdout: out.text, stderr: errOut.text };

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    const why = timedOut ? `检查 ${name} 超过 ${CHECK_TIMEOUT_MS / 1000} 秒未结束` : `检查 ${name} 起不来（${result.error.message}）`;
    return { ok: false, ...base, reason: reason(why, timedOut ? '把检查改快或只跑单个测试文件后重试' : '确认命令的可执行文件已安装，并写成 `node …` 这类简单形式') };
  }
  if (base.exitCode !== 0) {
    return { ok: false, ...base, reason: reason(`检查 ${name} 退出码 ${base.exitCode}`, '看 stderr 修到退出码 0，再作为 done 的证据') };
  }
  return { ok: true, ...base };
}
