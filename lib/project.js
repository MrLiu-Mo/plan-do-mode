// lib/project.js —— 项目定位 / 状态读写 / 灵感库 / 索引。
//
// 硬约束：
//   - 零依赖：只 import node: 内置模块与同目录 ./state.js（docs/API-FACTS.md §4）。
//   - 所有 JSON 写盘都是「写 <file>.tmp → fs.renameSync」原子替换（CONTRACT §4）。
//     多会话共享同一份 state，半写文件比报错更糟。
//   - 读状态失败一律「报错停止」，绝不静默重置（CONTRACT §4「版本」段）。
//   - 对外错误消息统一 'plando：…' 前缀并带下一步动作（CONTRACT §5）。

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_VERSION, createInitialState, migrate, inspectShape } from './state.js';

// 默认预算，与 config.js 的 DEFAULT_BUDGET / CONTRACT §4 保持一致。
// 这里内联而不是 import config.js：project.js 的依赖面固定为 node: + ./state.js。
const DEFAULT_BUDGET = Object.freeze({ mustUnderstand: 5, totalMinutes: 600 });

// .plando/ 下的固定文件名（PLAN §3 存储位置）。
export const PLANO_DIR = '.plando';
export const STATE_FILE = 'state.json';
export const LOG_FILE = 'log.jsonl';
export const CHECKS_FILE = 'checks.json';
export const IDEAS_FILE = 'ideas.json';
export const INDEX_FILE = 'projects.json';

// 模式产物（项目根下的顶层文件名）。立项时用来查「这些文件会不会被我覆盖」，
// 与 git.js 的 ARTIFACT_PATHS 口径一致，但这里不 import git.js（project.js 的依赖面更小）。
const ARTIFACTS = Object.freeze(['IDEA.md', 'TECH.md', 'VERIFY.md', 'HANDOFF.md', 'CHANGE-GUIDE.md']);

// 项目内三份文件的绝对路径；R4+ 的 cards/checks/scaffold 直接用这个，别各自拼。
export function projectPaths(dir) {
  const root = path.resolve(dir);
  const plandoDir = path.join(root, PLANO_DIR);
  return {
    root,
    plandoDir,
    statePath: path.join(plandoDir, STATE_FILE),
    logPath: path.join(plandoDir, LOG_FILE),
    checksPath: path.join(plandoDir, CHECKS_FILE),
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlankString(value) {
  return typeof value !== 'string' || value.trim() === '';
}

// 原子写 JSON：先写 <file>.tmp 再 rename 覆盖。目录不存在则先建。
function atomicWriteJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 单个 JSON 文件的大小上限。模式产物都是几 KB 量级，超过这个数说明文件被别的东西写坏了
 * （或者有人把大日志塞进来）。不设上限时 `JSON.parse` 会先吃掉整个文件再报错，
 * 一个 500 MB 的 state.json 足以把会话拖死（REVIEW-tools L4）。
 */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

// 读 JSON 文件：不存在返回 undefined；解析失败抛出可操作的错误（不静默重置）。
function readJson(file, label) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_JSON_BYTES) {
      throw new Error(
        `plando：${label} ${file} 有 ${Math.round(stat.size / 1024)} KB，超过 ${MAX_JSON_BYTES / 1024 / 1024} MB 上限——先备份再人工检查，不要直接重置。`,
      );
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `plando：${label} ${file} 不是合法 JSON（${err.message}）——先备份该文件再人工修回，不要删除重置，否则丢失项目历史。`,
    );
  }
}

/**
 * 读项目状态。
 * @returns {{ok: true, state: object, statePath: string, migrated?: boolean}
 *          | {ok: false, statePath: string, reason: string}}
 */
export function loadState(dir, options = {}) {
  if (isBlankString(dir)) {
    return { ok: false, statePath: '', reason: 'plando：没给项目目录——先确定项目路径，再调 plando_project action=open。' };
  }
  const { statePath } = projectPaths(dir);
  let parsed;
  try {
    parsed = readJson(statePath, '项目状态');
  } catch (err) {
    return { ok: false, statePath, reason: err.message };
  }
  if (parsed === undefined) {
    return {
      ok: false,
      statePath,
      reason: `plando：${statePath} 不存在——先 plando_project action=new 立项，或确认项目路径是否写错。`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      statePath,
      reason: `plando：${statePath} 顶层不是对象——先备份再人工修回；不要删除重置，否则丢失项目历史。`,
    };
  }
  const version = parsed.schemaVersion;
  if (!Number.isInteger(version)) {
    return {
      ok: false,
      statePath,
      reason: `plando：${statePath} 的 schemaVersion 是 ${JSON.stringify(version)}，不是整数——先备份再人工补回版本号，不要重置状态。`,
    };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      statePath,
      reason: `plando：${statePath} 的 schemaVersion 是 ${version}，高于本插件支持的 ${SCHEMA_VERSION}——把 plando 升级到匹配版本，不要重置状态。`,
    };
  }
  if (version < SCHEMA_VERSION) {
    const result = migrate(parsed);
    if (!result.ok) return { ok: false, statePath, reason: result.reason };
    // PLAN §3：读到已知旧版 → migrate 升版后写回磁盘。
    if (options.writeBack !== false) {
      try {
        atomicWriteJson(statePath, result.state);
      } catch (err) {
        return {
          ok: false,
          statePath,
          reason: `plando：旧版状态迁移后写回失败（${err.message}）——检查 ${path.dirname(statePath)} 的写权限后重试。`,
        };
      }
    }
    return { ok: true, state: result.state, statePath, migrated: true };
  }
  // 当前版本的 state 也不盲信：手改、坏编辑器、上一版写坏都会留下 null / 非对象元素，
  // 流到工具层就变成不可读的 `Cannot read properties of null`（REVIEW-state F10）。
  const problems = inspectShape(parsed);
  if (problems.length) {
    return {
      ok: false,
      statePath,
      reason: `plando：${statePath} 结构不对（${problems.join('；')}）——先备份 .plando/ 再人工修回，不要重置状态。`,
    };
  }
  return { ok: true, state: parsed, statePath };
}

/**
 * 写项目状态（原子替换），并把 updatedAt 刷成当前时间。
 * @returns {object} 实际落盘的 state（带新的 updatedAt）
 */
export function saveState(dir, state) {
  if (isBlankString(dir)) throw new Error('plando：saveState 需要项目目录——先确定项目路径。');
  if (!isPlainObject(state)) throw new Error('plando：saveState 的 state 必须是对象——先 plando_project action=open 读回状态。');
  const { statePath } = projectPaths(dir);
  const next = { ...state, updatedAt: new Date().toISOString() };
  atomicWriteJson(statePath, next);
  return next;
}

/**
 * 打开已有项目：读回 state 并给出定位信息；失败返回 ok:false 而不是抛错。
 */
export function openProject(dir) {
  const loaded = loadState(dir);
  const paths = projectPaths(dir);
  if (!loaded.ok) return { ok: false, dir: paths.root, statePath: paths.statePath, reason: loaded.reason };
  const state = { ...loaded.state, dir: paths.root };
  return { ok: true, dir: paths.root, statePath: paths.statePath, state, migrated: Boolean(loaded.migrated) };
}

/**
 * 立项：建 .plando/、写初始 state、初始化空灵感库（可选登记索引）。
 * @param {string} dir 项目目录
 * @param {{name?: string, budget?: object, dataRoot?: string}} [options]
 *        dataRoot 给了才初始化 <dataRoot>/ideas.json 与 projects.json 索引。
 */
export function initProject(dir, options = {}) {
  if (isBlankString(dir)) throw new Error('plando：initProject 需要项目目录——先确定项目路径。');
  const paths = projectPaths(dir);
  const { name, budget, dataRoot } = isPlainObject(options) ? options : {};
  if (fs.existsSync(paths.statePath)) {
    const existing = loadState(dir);
    const stage = existing.ok ? existing.state.stage : '未知';
    return {
      ok: false,
      dir: paths.root,
      statePath: paths.statePath,
      reason: `plando：${paths.root} 已有项目状态（阶段 ${stage}）——用 plando_project action=open 打开它，不要重建。`,
    };
  }
  fs.mkdirSync(paths.plandoDir, { recursive: true });
  // 目录里已经有同名产物 → 立项后第一次 clarify_done 就会把它们覆盖掉。
  // 用户手写的 IDEA.md 不该被我们悄悄替换，宁可拒绝并让人自己选（REVIEW-tools G4b）。
  const clashing = ARTIFACTS.filter((name) => fs.existsSync(path.join(paths.root, name)));
  if (clashing.length > 0) {
    return {
      ok: false,
      dir: paths.root,
      statePath: paths.statePath,
      reason: `plando：${paths.root} 里已经有 ${clashing.join('、')}——立项后会把它们当成模式产物覆盖。换一个空目录，或先把这些文件挪走。`,
    };
  }
  // 空日志文件让「第一次推进」可以直接 append。
  fs.writeFileSync(paths.logPath, '', { flag: 'a' });

  const state = createInitialState({ name, dir: paths.root, budget });
  // CONTRACT §4：budget 是立项时写入的 state 快照；state.js 不填时由这里补默认值，
  // 保证之后所有渲染/校验都读 state.budget，不受用户改配置影响。
  if (!isPlainObject(state.budget)) {
    state.budget = isPlainObject(budget) ? { mustUnderstand: 5, totalMinutes: 600, ...budget } : { mustUnderstand: 5, totalMinutes: 600 };
  }
  const saved = saveState(paths.root, state);

  if (!isBlankString(dataRoot)) {
    const root = path.resolve(dataRoot);
    ensureIdeas(root);
    registerProject(root, paths.root, saved.projectId);
  }
  return { ok: true, dir: paths.root, statePath: paths.statePath, state: saved };
}

// 灵感库文件路径：按 PLAN §3，ideas.json 顶层直接是数组（不是 { ideas: [] } 包装）。
function ideasPath(dataRoot) {
  return path.join(path.resolve(dataRoot), IDEAS_FILE);
}

// 确保 ideas.json 存在（不存在则写空数组）；存在则不动。
function ensureIdeas(dataRoot) {
  const file = ideasPath(dataRoot);
  if (fs.existsSync(file)) return;
  atomicWriteJson(file, []);
}

/** 读灵感库：文件不存在返回 []；文件损坏抛中文错误（不静默重置）。 */
export function readIdeas(dataRoot) {
  if (isBlankString(dataRoot)) throw new Error('plando：readIdeas 需要 dataRoot——先读配置 config.dataRoot。');
  const file = ideasPath(dataRoot);
  const parsed = readJson(file, '灵感库');
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`plando：灵感库 ${file} 顶层不是数组——先备份再人工修回，不要删除重置。`);
  }
  return parsed;
}

/** 写灵感库（原子替换），返回写入的数组。 */
export function writeIdeas(dataRoot, list) {
  if (isBlankString(dataRoot)) throw new Error('plando：writeIdeas 需要 dataRoot——先读配置 config.dataRoot。');
  if (!Array.isArray(list)) throw new Error('plando：writeIdeas 的 list 必须是数组——先把灵感按数组组织好。');
  atomicWriteJson(ideasPath(dataRoot), list);
  return list;
}

// 项目索引：<dataRoot>/projects.json，形如 { version: 1, projects: { [dir]: projectId } }。
function indexPath(dataRoot) {
  return path.join(path.resolve(dataRoot), INDEX_FILE);
}

function readIndex(dataRoot) {
  const parsed = readJson(indexPath(dataRoot), '项目索引');
  if (!isPlainObject(parsed) || !isPlainObject(parsed.projects)) return { version: 1, projects: {} };
  return { version: 1, projects: parsed.projects };
}

function registerProject(dataRoot, dir, projectId) {
  const index = readIndex(dataRoot);
  index.projects[path.resolve(dir)] = projectId;
  atomicWriteJson(indexPath(dataRoot), index);
}

/** 列出 dataRoot 索引里的所有项目（按 updatedAt 倒序）；读不到的项目带 ok:false 一并返回。 */
export function listProjects(dataRoot) {
  if (isBlankString(dataRoot)) return [];
  const index = readIndex(dataRoot);
  const rows = [];
  for (const [dir, projectId] of Object.entries(index.projects)) {
    const loaded = loadState(dir);
    if (loaded.ok) {
      rows.push({
        ok: true,
        dir,
        projectId: loaded.state.projectId || projectId,
        name: loaded.state.name,
        stage: loaded.state.stage,
        updatedAt: loaded.state.updatedAt,
      });
    } else {
      rows.push({ ok: false, dir, projectId, reason: loaded.reason });
    }
  }
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.dir.localeCompare(b.dir));
  return rows;
}
