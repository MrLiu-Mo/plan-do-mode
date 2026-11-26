// lib/config.js —— 零依赖配置校验：读插件 config，产出带默认值的规范化对象。
//
// 硬约束（docs/API-FACTS.md §4）：只 import node: 内置模块，不 import 任何裸包名。
// 错误消息形状（CONTRACT §5）：plando：配置 <字段><怎么了>——<怎么改>。
// 这里的校验发生在插件最外层：坏配置必须在启动时炸掉，而不是等到写盘才半途失败。

import os from 'node:os';
import path from 'node:path';

// 默认预算：user 项最多 5 条、总时长最多 600 分钟（PLAN §3 TECH.md 预算硬上限）。
export const DEFAULT_BUDGET = Object.freeze({ mustUnderstand: 5, totalMinutes: 600 });

/**
 * 默认「大项目」阈值：总预计分钟数超过它就判 large（PLAN §3 / CONTRACT §3）。
 *
 * 为什么是 300 而不是 180：分钟数的语义是「用户亲手敲并跑通的时间」，不含学概念与调试。
 * 按这个口径，一个带导出功能的 markdown 记账系统大约 200–280 分钟——它是「一个下午能做出
 * 雏形」的项目，不该被判成大项目、被迫先走一轮验证。180 会让几乎所有有真实功能的项目
 * 都触发 large 门，那道门就从「提醒」退化成「每次都得绕一圈的仪式」。
 *
 * 注意 state.js 里有一份同值常量（那个文件零 import，不能反向依赖本文件）；
 * test/state.budget.test.js 与 test/config.test.js 都断言了这个值，改一处漏另一处会红。
 */
export const DEFAULT_SIZE_THRESHOLD_MINUTES = 300;

// 配置错误的统一前缀，测试会断言它以 'plando：配置' 开头。
const PREFIX = 'plando：配置';

// 抛一条中文配置错误：字段名 + 实际值 + 怎么改。
function fail(field, detail, fix) {
  throw new Error(`${PREFIX} ${field}${detail}——${fix}`);
}

// 是不是普通对象（排除 null / 数组）。
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 字符串为空/全空白？undefined 也当空。用于 dataRoot / defaultProjectDir 的缺省判断。
function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// 展开开头的 ~（只处理开头的 ~ 与 ~/，不做通配）。
function expandHome(dir) {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

// 校验 budget：对象、两项正整数；没给的项用默认值补齐。
function readBudget(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_BUDGET };
  if (!isPlainObject(raw)) {
    fail('budget 必须是对象', `，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`, '写成 { mustUnderstand: 5, totalMinutes: 600 }');
  }
  const budget = {};
  for (const key of ['mustUnderstand', 'totalMinutes']) {
    const value = raw[key];
    if (value === undefined) {
      budget[key] = DEFAULT_BUDGET[key];
      continue;
    }
    if (!Number.isInteger(value) || value <= 0) {
      fail(`budget.${key} 必须是正整数`, `，收到 ${JSON.stringify(value)}`, `改成 >=1 的整数，例如 ${DEFAULT_BUDGET[key]}`);
    }
    budget[key] = value;
  }
  return budget;
}

// 校验 autoCommit：默认 false，接受布尔与 'true'/'false' 字符串（大小写不敏感）与 1/0。
function readAutoCommit(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  fail('autoCommit 必须是布尔值', `，收到 ${JSON.stringify(raw)}`, '写成 true / false（要开自动提交才填 true）');
}

// 校验 sizeThresholdMinutes：正整数，缺省用 DEFAULT_SIZE_THRESHOLD_MINUTES。
function readSizeThreshold(raw) {
  if (raw === undefined || raw === null) return DEFAULT_SIZE_THRESHOLD_MINUTES;
  if (!Number.isInteger(raw) || raw <= 0) {
    fail(
      'sizeThresholdMinutes 必须是正整数',
      `，收到 ${JSON.stringify(raw)}`,
      `改成 >=1 的整数，例如 ${DEFAULT_SIZE_THRESHOLD_MINUTES}（总预计分钟超过它才判大项目）`,
    );
  }
  return raw;
}

// 校验 guardExtraDeny：默认空数组，必须是非空字符串组成的数组。
function readGuardExtraDeny(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail('guardExtraDeny 必须是字符串数组', `，收到 ${typeof raw}`, '写成 [] 或 [\'工具名\']');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`guardExtraDeny[${index}] 必须是非空字符串`, `，收到 ${JSON.stringify(item)}`, '删掉它或改成具体工具名');
    }
    return item.trim();
  });
}

// 校验一个路径字段：空则用 fallback，否则必须是字符串并 resolve 成绝对路径。
function readPath(raw, field, fallback) {
  if (isBlank(raw)) return fallback;
  if (typeof raw !== 'string') {
    fail(`${field} 必须是字符串`, `，收到 ${typeof raw}`, '写绝对路径，或留空用默认值');
  }
  return path.resolve(expandHome(raw.trim()));
}

/**
 * 读入插件原始 config，返回规范化后的配置对象。
 * 入参可以是 undefined / {}（全部走默认值）；非对象抛中文错误。
 * @param {object} [raw]
 * @returns {{dataRoot: string, budget: {mustUnderstand: number, totalMinutes: number},
 *            defaultProjectDir: string, autoCommit: boolean, guardExtraDeny: string[],
 *            sizeThresholdMinutes: number}}
 */
export function readConfig(raw) {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    fail('整体必须是对象', `，收到 ${Array.isArray(raw) ? 'array' : typeof raw}`, '传 {} 或省略');
  }
  const input = raw || {};

  const dataRoot = readPath(input.dataRoot, 'dataRoot', path.join(os.homedir(), '.plando'));
  // 项目默认落在 dataRoot/projects 下：不往用户 home 根目录撒目录。
  const defaultProjectDir = readPath(input.defaultProjectDir, 'defaultProjectDir', path.join(dataRoot, 'projects'));

  return {
    dataRoot,
    budget: readBudget(input.budget),
    defaultProjectDir,
    autoCommit: readAutoCommit(input.autoCommit),
    guardExtraDeny: readGuardExtraDeny(input.guardExtraDeny),
    // 大项目阈值跟着预算一起在立项时快照进 state，历史项目的判定不随配置变动。
    sizeThresholdMinutes: readSizeThreshold(input.sizeThresholdMinutes),
  };
}

export default readConfig;
