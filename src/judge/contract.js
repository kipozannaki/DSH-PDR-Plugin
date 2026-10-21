/**
 * 声明契约 —— "这个插件该干什么"的机器可查形式
 *
 * 三个来源（优先级从高到低）：
 *   1. manifest 显式声明（package.json 的 "firewall" 字段，我们提出的约定）：
 *        "firewall": { "hosts": ["api.trae.com"], "grants": ["global-credentials"] }
 *   2. 体检卡能力面（代码静态提取）→ 推导允许的 API 类别
 *   3. 保守默认：只许 own + temp
 *
 * 判定哲学（延续"能力共现 ≠ 恶意"）：契约不是紧箍咒式的白名单监狱，
 * 而是"声明过的自由"——本职范围内的行为零打扰，越出声明范围才记违规。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** api 名 → 能力类别 */
export function apiClassOf(api) {
  const a = String(api);
  if (/^fetch|^https?:|^net\.|^(http|https)\./.test(a)) return 'network';
  if (a.startsWith('child_process')) return 'shell';
  if (a.startsWith('fs')) return 'fs';
  return 'other';
}

/** 能力面 → 允许的 API 类别 */
const CAP_TO_API = {
  network: 'network',
  shell: 'shell',
  'fs-read': 'fs',
  'fs-write': 'fs',
  env: null,
  credentials: null,
  'dynamic-code': null,
};

export function deriveContract({ name, dir, capabilities = [], manifest = null }) {
  let fw = {};
  try {
    // 显式传入的 manifest 优先；否则读目录里的 package.json（无目录/无文件则走默认）
    const m = manifest ?? (dir && existsSync(path.join(dir, 'package.json'))
      ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      : null);
    fw = m?.firewall ?? {};
  } catch { /* 契约读取失败走默认 */ }

  const apiClasses = new Set();
  for (const cap of capabilities) {
    const cls = CAP_TO_API[cap];
    if (cls) apiClasses.add(cls);
  }
  if (apiClasses.size === 0) apiClasses.add('fs'); // 最基本的本地 I/O 免打扰

  return {
    name,
    capabilities: [...apiClasses],
    declaredCapabilities: capabilities,
    // 允许的路径类别：自己的 + 临时 + dsh 共享（读）；敏感/跨插件需显式授权
    allowedPathClasses: ['own', 'temp', 'system', 'dsh-shared', 'unknown'],
    // 声明的目的地；scope='closed' 时白名单外一律违规，'open'（未声明/未推断）不做目的地判定
    declaredHosts: fw.hosts ?? [],
    scope: (fw.hosts && fw.hosts.length) ? 'closed' : 'open',
    // 显式授权（'global-credentials' / 'cross-plugin' / 'system-write'…）
    grants: fw.grants ?? [],
    source: fw.hosts || fw.grants ? 'manifest' : (capabilities.length ? 'health-card' : 'default'),
  };
}

export function contractAllowsApi(contract, api) {
  return contract.capabilities.includes(apiClassOf(api));
}

/**
 * 契约规范化：补齐判定所需字段（allowedPathClasses 等），
 * 统一词汇表——contract.capabilities 用判定词表（network/shell/fs），
 * declaredCapabilities 保留细粒度（fs-read/fs-write…）供展示。
 */
export function normalizeContract(partial) {
  const p = partial ?? {};
  const manifest = (p.declaredHosts || p.grants)
    ? { firewall: { hosts: p.declaredHosts, grants: p.grants } }
    : null;
  const base = deriveContract({
    name: p.name,
    capabilities: p.declaredCapabilities ?? p.capabilities ?? [],
    manifest,
  });
  return { ...base, ...p, scope: p.scope ?? base.scope, source: p.source ?? base.source };
}

export function contractAllowsPathClass(contract, cls) {
  if (contract.allowedPathClasses.includes(cls)) return true;
  if (cls === 'sensitive') return contract.grants.includes('global-credentials');
  if (cls === 'other-plugin') return contract.grants.includes('cross-plugin');
  return false;
}

export function contractAllowsHost(contract, host) {
  if (contract.scope !== 'closed') return true; // 未声明/未推断 → 不做目的地判定（防误报）
  return hostMatchesSafe(host, contract.declaredHosts);
}

import { hostMatches } from './paths.js';
function hostMatchesSafe(host, patterns) {
  try { return hostMatches(host, patterns); } catch { return false; }
}
