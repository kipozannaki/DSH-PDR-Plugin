/**
 * Bootstrap 层出口（带 I/O 的组装层）
 *
 * detect.js 与 adapters.js 是纯函数（可单测）；这一个文件负责把"探针实际计数"
 * 取出来、判一次存储可写性、读宿主版本，并落一份 runtime.json 证据快照。
 *
 * runtime.json 的用途：
 *   - `dsh-pdr doctor` 在没有活会话时也能回答"上次会话的监控状态是什么"
 *   - 审计留档：会话结束后面板关掉，健康证据仍然在本地
 * 只写脱敏后的对象（maskPath 已处理 home / DSH_HOME）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { collectRuntime, maskPath, HEALTH, RUNTIME_SCHEMA, evaluateHealth } from './detect.js';
import { adapterMatrix, resolveAdapter, ADAPTERS, looksLikeDesktop, ADAPTER_SCHEMA } from './adapters.js';
import { resolveDshNodeModules } from '../util/dsh-deps.js';

export {
  collectRuntime, evaluateHealth, maskPath, HEALTH, RUNTIME_SCHEMA,
  adapterMatrix, resolveAdapter, ADAPTERS, looksLikeDesktop, ADAPTER_SCHEMA,
};

/**
 * 读宿主 dsh 版本。找不到就返回 null —— 版本只用于展示与兼容判断，
 * 读不到不该影响监控本身。
 */
export function readHostVersion() {
  if (process.env.DSH_VERSION) return process.env.DSH_VERSION;
  try {
    const nm = resolveDshNodeModules();
    if (!nm) return null;
    const pkg = path.join(nm, '@deepseek-ai', 'dsh', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null;
  } catch { return null; }
}

/** 事件目录是否可写（健康状态里 storage-writable 的证据） */
export function probeStorageWritable(dataDir) {
  if (!dataDir) return { dataDir: null, writable: null };
  try {
    const st = fs.statSync(dataDir);
    if (!st.isDirectory()) return { dataDir, writable: false };
    fs.accessSync(dataDir, fs.constants.W_OK);
    return { dataDir, writable: true };
  } catch { return { dataDir, writable: false }; }
}

/**
 * 取一次完整运行时诊断。
 * @param {object} opts
 * @param {object} opts.probe  probe-core 模块
 * @param {string} [opts.dataDir]
 * @param {string} [opts.pluginVersion]
 * @param {string} [opts.profile]
 */
export function collect({ probe, dataDir = null, pluginVersion = null, profile = null, env = process.env, dshVersion = undefined } = {}) {
  const stats = probe && typeof probe.getStats === 'function' ? probe.getStats() : {};
  const coverage = probe && typeof probe.getCoverage === 'function'
    ? probe.getCoverage()
    : { categories: [], gaps: [], total: 0, doubleWrapped: 0 };
  const attribution = probe && typeof probe.getAttribution === 'function' ? probe.getAttribution() : {};
  const storage = probeStorageWritable(dataDir);
  // 存储争用（多进程写同一 JSONL 的瞬时失败）单独上报，不与探针内部错误混算
  storage.errors = Number(stats.storeErrors ?? 0);
  return collectRuntime({
    env,
    probe: stats,
    coverage,
    attribution,
    storage,
    profile: profile ?? stats.profile ?? null,
    pluginVersion,
    dshVersion: dshVersion === undefined ? readHostVersion() : dshVersion,
  });
}

/**
 * 落一份证据快照（脱敏后）。失败不影响监控主流程。
 * @returns {string|null} 写入的路径
 */
export function writeRuntimeSnapshot(runtime, dataDir, { probe = null } = {}) {
  if (!dataDir || !runtime) return null;
  const file = path.join(dataDir, 'runtime.json');
  const tmp = `${file}.tmp-${process.pid}`;
  const body = JSON.stringify(runtime, null, 2);
  const write = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      return file;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
      return null;
    }
  };
  // 产品自身的落盘不进时间线（否则每次健康检查都制造一条事件）
  if (probe && typeof probe.silent === 'function') return probe.silent(write);
  return write();
}

/** 读上次会话留下的快照（CLI doctor 用） */
export function readRuntimeSnapshot(dataDir) {
  if (!dataDir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')); } catch { return null; }
}
