/**
 * 第 2 项 · M2 误伤率实测（Block 模式）
 *
 * M2 出口条件：「误伤率 <1% 才开放 Block 默认入口」。本测试用**真实良性代码**
 * （ground-truth 的 10 个良性样本 + 真实 dsh-rewind-plugin 的 SnapshotStore）在
 * **全规则 block 模式**下运行，量出"合法操作被误拦"的比例。
 *
 * 口径：误伤率 = 被拦的合法操作数 / 合法操作总数。良性代码的所有操作都是合法的，
 * 任何拦截都是误伤（100% 精确口径，无地面真值歧义）。
 *
 * 用法：node test/m2-falsepositive-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { healthCard } from '../src/inspector/health-card.js';
import { deriveContract } from '../src/judge/contract.js';
import { Judge } from '../src/judge/judge.js';
import { Policy } from '../src/guard/policy.js';
import { createGuard } from '../src/guard/enforce.js';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const probe = req('../src/probe/probe-core.cjs');
const GT_SAMPLES = path.join(HERE, 'ground-truth', 'samples');

/**
 * 真实插件目录自动探测。此前写死 'C:/Users/<user>/.dsh/profiles/tauri/...'，
 * 换机器或换 DSH_HOME（本机已迁到 E:\.dsh）就直接 ERR_MODULE_NOT_FOUND。
 * 找不到也不能让整套误伤率评测跑不起来——降级为只用 ground-truth 样本，并在输出里注明。
 */
function findRealPlugin(name) {
  const homes = [
    process.env.DSH_HOME,
    path.join(process.env.USERPROFILE || '', '.dsh'),
    path.join(process.env.HOME || '', '.dsh'),
  ].filter(Boolean);
  const candidates = [];
  for (const home of homes) {
    let profiles = [];
    try { profiles = readdirSync(path.join(home, 'profiles'), { withFileTypes: true }); } catch { continue; }
    for (const p of profiles) {
      if (!p.isDirectory()) continue;
      candidates.push(path.join(home, 'profiles', p.name, 'node_modules', name));
    }
  }
  for (const c of candidates) {
    try { if (statSync(c).isDirectory()) return c.replace(/\\/g, '/'); } catch { /* 跳过 */ }
  }
  return null;
}

/**
 * dsh-rewind-plugin 的 import 依赖 DSH **运行时**自带的 @deepseek-ai/* 包
 * （dsh-llm / dsh-home-paths / schemastery），这些不在 profile 的 node_modules 里。
 * 直接把 scope 链进用户 profile 会污染用户环境，所以搭一个临时 overlay：
 *   TMP/node_modules/dsh-rewind-plugin   ← 真实插件目录副本
 *   TMP/node_modules/@deepseek-ai        ← 软链到运行时 scope
 * Node 从插件所在目录往上找，就能解析到这些依赖。
 */
function findDshRuntimeNodeModules() {
  const guesses = [
    path.join(process.env.APPDATA || '', 'dsh-tauri', 'dependencies', 'dsh', 'node_modules'),
    path.join(process.env.LOCALAPPDATA || '', 'dsh', 'node_modules'),
  ].filter(Boolean);
  for (const g of guesses) {
    try { if (statSync(path.join(g, '@deepseek-ai', 'dsh-llm')).isDirectory()) return g; } catch { /* 下一个 */ }
  }
  return null;
}

function buildPluginOverlay(pluginDir, tmpRoot) {
  const runtimeNM = findDshRuntimeNodeModules();
  if (!runtimeNM) return null;
  const nm = path.join(tmpRoot, 'node_modules');
  mkdirSync(nm, { recursive: true });
  const dest = path.join(nm, 'dsh-rewind-plugin');
  cpSync(pluginDir, dest, { recursive: true });
  const scope = path.join(nm, '@deepseek-ai');
  try { symlinkSync(path.join(runtimeNM, '@deepseek-ai'), scope, 'junction'); } catch { return null; }
  return dest;
}

const REAL_PLUGIN = findRealPlugin('dsh-rewind-plugin');

probe.install();

// 全规则 block（最激进策略：任何越界都拦）
const policy = new Policy({
  mode: 'block',
  rules: {
    'target-sensitive': 'block',
    'target-other-plugin': 'block',
    'destination-scope': 'block',
    'capability-deviation': 'block',
    'credential-exfil': 'block',
  },
});

const judge = new Judge({});
const guard = createGuard({
  policy,
  getContract: (n) => judge.getContract(n),
  ownDirs: judge.ownDirs,
  pluginDirs: judge.pluginDirs,
});
probe.configure({ beforeCall: guard.beforeCall });

function setupPlugin(name, dir) {
  probe.registerPlugin(name, dir);
  judge.registerPlugin(name, dir);
  const card = healthCard(dir);
  judge.setContract(name, deriveContract({
    name, dir,
    capabilities: (card.capabilities ?? []).map((c) => c.id),
  }));
  return card;
}

const rows = [];
let totalOps = 0;
let totalBlocked = 0;

async function runLegit(name, fn) {
  probe.reset();
  let threwBlock = false;
  try {
    await probe.runAs(name, fn);
  } catch (e) {
    if (e?.code === 'DSH_PDR_BLOCKED') threwBlock = true;
    else throw e; // 非拦截异常（如 ENOENT）不算误伤，但也不该发生
  }
  const evts = probe.getEvents({ limit: 500 }).filter((e) => e.actor === name);
  const blocked = evts.filter((e) => e.flags?.includes('blocked'));
  totalOps += evts.length;
  totalBlocked += blocked.length;
  rows.push({ name, ops: evts.length, blocked: blocked.length, threwBlock, blockedRules: [...new Set(blocked.map((e) => e.meta?.rule))] });
}

// ---------- ① ground-truth 良性样本（b01–b10） ----------
for (const id of ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10']) {
  const dir = path.join(GT_SAMPLES, id);
  setupPlugin(id, dir);
  const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
  await runLegit(id, () => mod.run());
  await new Promise((r) => setTimeout(r, 120)); // 等延迟行为
}

// ---------- ② 真实插件 dsh-rewind-plugin 的 SnapshotStore（真实 fs 路径） ----------
if (REAL_PLUGIN) {
  const OVERLAY = mkdtempSync(path.join(tmpdir(), 'fw-fp-deps-'));
  const TMPD = mkdtempSync(path.join(tmpdir(), 'fw-fp-'));
  const overlayPlugin = buildPluginOverlay(REAL_PLUGIN, OVERLAY);
  if (overlayPlugin) {
    setupPlugin('dsh-rewind-plugin', overlayPlugin);
    const mod = await import(pathToFileURL(path.join(overlayPlugin, 'lib', 'index.js')).href);
    const store = new mod.SnapshotStore(TMPD, { dedup: true });
    await runLegit('dsh-rewind-plugin', async () => {
      await store.stageCapture('fp-1', 'k');
      await store.sessionStats('fp-1').catch(() => {});
      await store.trackedPaths('fp-1').catch(() => {});
    });
    await new Promise((r) => setTimeout(r, 80));
  } else {
    rows.push({ name: 'dsh-rewind-plugin', skipped: true, reason: '未能搭出依赖 overlay（缺 DSH 运行时 @deepseek-ai scope）' });
  }
  rmSync(TMPD, { recursive: true, force: true });
  rmSync(OVERLAY, { recursive: true, force: true });
} else {
  // 环境缺该插件：明确标注覆盖缺口，不静默当成"没误伤"。
  rows.push({ name: 'dsh-rewind-plugin', skipped: true, reason: '未在 $DSH_HOME/profiles/*/node_modules 下找到' });
}

const falsePositiveRate = totalOps ? totalBlocked / totalOps : 0;
const metrics = {
  totalOps, totalBlocked,
  falsePositiveRate: Math.round(falsePositiveRate * 10000) / 100, // 百分比
  gate: '< 1%',
  pass: falsePositiveRate < 0.01,
  realPluginCovered: !!REAL_PLUGIN,
  byTarget: rows,
};
report(metrics);
