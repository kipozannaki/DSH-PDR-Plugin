/**
 * 真实插件体检回归 v0（M1 出口条件的前置校准）
 *
 * 对已安装的插件目录跑体检卡（纯静态、只读），输出判定分布与能力面统计，
 * 用于观察启发式信号在真实世界代码上的误报/漏报。
 *
 * 用法：node test/regression.mjs [node_modules 目录 ...]
 *   缺省扫描：当前用户 ~/.dsh/profiles 下所有 profile 的 node_modules
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { report } from './_report.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { healthCard } from '../src/inspector/health-card.js';
import { trustScore } from '../src/inspector/trust-score.js';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function defaultRoots() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = path.join(home, 'profiles');
  if (!existsSync(profiles)) return [];
  return readdirSync(profiles, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profiles, e.name, 'node_modules'))
    .filter((p) => existsSync(p));
}

/** 插件识别：声明了 dsh 字段（bundle/client），或名字含 dsh 的社区包；排除纯库 */
function isPluginCandidate(name, manifest) {
  if (name.startsWith('@deepseek-ai/')) return false;
  if (manifest.dsh != null) return true;
  return /dsh/i.test(name);
}

function listCandidates(root) {
  const out = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const dirs = e.isDirectory()
      ? (e.name.startsWith('@')
        ? readdirSync(path.join(root, e.name), { withFileTypes: true })
            .filter((s) => s.isDirectory()).map((s) => ({ name: `${e.name}/${s.name}`, dir: path.join(root, e.name, s.name) }))
        : [{ name: e.name, dir: path.join(root, e.name) }])
      : [];
    for (const c of dirs) {
      const mp = path.join(c.dir, 'package.json');
      if (!existsSync(mp)) continue;
      try {
        const manifest = JSON.parse(readFileSync(mp, 'utf8'));
        if (isPluginCandidate(c.name, manifest)) out.push({ ...c, manifest });
      } catch { /* 坏包跳过 */ }
    }
  }
  return out;
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : defaultRoots();
const results = [];
for (const root of roots) {
  for (const cand of listCandidates(root)) {
    let card;
    try {
      card = healthCard(cand.dir);
    } catch (error) {
      card = { error: String(error?.message ?? error) };
    }
    const trust = card.error ? null : trustScore({
      redLines: card.redLines.map((r) => r.rule),
      capabilities: card.capabilities.map((c) => c.id),
      behavior: {}, // 静态回归：无运行时行为数据
    });
    results.push({
      profile: path.basename(path.dirname(root)),
      name: cand.name,
      version: cand.manifest.version ?? '',
      declaredDsh: cand.manifest.dsh != null,
      verdict: card.verdict ?? 'ERROR',
      trust: trust ? trust.score : null,
      capabilities: (card.capabilities ?? []).map((c) => c.id),
      redLines: (card.redLines ?? []).map((r) => r.rule),
      patchEntries: card.patchEntries ?? [],
      scannedFiles: card.scanned?.files ?? 0,
      error: card.error,
    });
  }
}

const summary = {
  total: results.length,
  byVerdict: results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {}),
  withRedLines: results.filter((r) => r.redLines.length > 0).length,
  capabilityFreq: results.flatMap((r) => r.capabilities).reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {}),
};

// 这是**信息性扫描**：列出本机各 profile 里插件的体检结果，本身没有通过/失败判定。
// requireVerdict: false 让它失败退出码保持 0，但仍会打印说明，避免被误当成"已验证通过"。
report({ summary, results },
  ['[info] 信息性扫描：输出为本机已装插件的体检明细，不含通过/失败判定；'],
  { requireVerdict: false });
