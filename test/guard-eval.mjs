/**
 * M2 拦截评测（Block 模式）：策略决定 + 预执行拦截 + fail-safe
 *
 * 硬指标：
 *  ① 拦截生效：敏感目标 / 能力面越界 / 目的地越界 / 当场外发（凭据→联网）在 block 策略下抛 FirewallBlockError
 *  ② 本职零拦截：同一套 hook + block 策略下，正职 I/O 不被误拦
 *  ③ 默认 alarm-only：不开 block 时绝不拦（只告警）
 *  ④ fail-safe：拦截引擎自身异常 → 放行（不拖垮宿主）
 *
 * 用法：node test/guard-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Judge } from '../src/judge/judge.js';
import { deriveContract } from '../src/judge/contract.js';
import { Policy } from '../src/guard/policy.js';
import { createGuard } from '../src/guard/enforce.js';

const req = createRequire(import.meta.url);
const probe = req('../src/probe/probe-core.cjs');

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-guard-'));
const DIR = path.join(TMP, 'plg');
mkdirSync(DIR, { recursive: true });
writeFileSync(path.join(DIR, 'own.json'), '{}');
// 假凭据（不在 DIR 下 → classifyPath 判 sensitive；真实存在以便放行场景能读到）
const HOME = path.join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
const CRED = path.join(HOME, '.credentials.yaml');
writeFileSync(CRED, 'fake: true\n');
const fs = req('node:fs'); // 探针包装后的 fs

// 时序 A：探针先装
probe.install();

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

/** 跑一个调用，捕获是否抛出 */
function run(actor, fn) {
  probe.reset();
  try {
    probe.runAs(actor, fn);
    return { threw: false, error: null };
  } catch (error) {
    return { threw: true, error };
  }
}

function setup(contract, policySpec) {
  const judge = new Judge({});
  judge.registerPlugin('plg', DIR);
  if (contract) judge.setContract('plg', contract);
  const policy = new Policy(policySpec ?? { mode: 'alarm' });
  const guard = createGuard({
    policy,
    getContract: (n) => judge.getContract(n),
    ownDirs: judge.ownDirs,
    pluginDirs: judge.pluginDirs,
  });
  probe.configure({ beforeCall: guard.beforeCall });
  return { judge, policy, guard };
}

const BLOCK = (rules) => ({ mode: 'alarm', rules });

// ---------- ① 默认 alarm-only：敏感读不拦 ----------
{
  const { guard } = setup(deriveContract({ name: 'plg', capabilities: ['fs-read'], manifest: { firewall: {} } }), { mode: 'alarm' });
  const r = run('plg', () => fs.readFileSync(CRED, 'utf8'));
  const d = guard.beforeCall('plg', 'fs.readFileSync', CRED);
  check('S1', '默认 alarm-only：敏感读告警不拦截', !r.threw && d?.action === 'alarm' && d?.rule === 'target-sensitive', JSON.stringify({ threw: r.threw, action: d?.action }));
}

// ---------- ② block 敏感目标 ----------
{
  setup(deriveContract({ name: 'plg', capabilities: ['fs-read'], manifest: { firewall: {} } }), BLOCK({ 'target-sensitive': 'block' }));
  const r = run('plg', () => fs.readFileSync(CRED, 'utf8'));
  const blocked = probe.getEvents({ limit: 20 }).some((e) => e.flags?.includes('blocked'));
  check('S2', 'block 敏感目标：抛 FirewallBlockError + 记 blocked', r.threw && r.error?.code === 'DSH_PDR_BLOCKED' && blocked, r.error?.name);
}

// ---------- ③ block 能力面越界（声明无网络却联网） ----------
{
  setup(deriveContract({ name: 'plg', capabilities: ['fs-read'], manifest: { firewall: {} } }), BLOCK({ 'capability-deviation': 'block' }));
  const r = run('plg', () => globalThis.fetch('http://203.0.113.7/x').catch(() => {}));
  check('S3', 'block 能力面越界：未声明 network 却联网被拦', r.threw && r.error?.code === 'DSH_PDR_BLOCKED', r.error?.name);
}

// ---------- ④ block 目的地越界（封闭契约 + 未声明目的地） ----------
{
  setup(deriveContract({ name: 'plg', capabilities: ['network'], manifest: { firewall: { hosts: ['api.trae.example'] } } }), BLOCK({ 'destination-scope': 'block' }));
  const r = run('plg', () => globalThis.fetch('http://203.0.113.7/x').catch(() => {}));
  check('S4', 'block 目的地越界：封闭契约外的目的地被拦', r.threw && r.error?.code === 'DSH_PDR_BLOCKED', r.error?.name);
}

// ---------- ⑤ block 当场外发（凭据→联网） ----------
{
  // 授权读凭据（grant），否则敏感读先被拦，测不到外发组合
  setup(deriveContract({ name: 'plg', capabilities: ['network', 'fs-read'], manifest: { firewall: { grants: ['global-credentials'] } } }), BLOCK({ 'credential-exfil': 'block' }));
  const rCred = run('plg', () => fs.readFileSync(CRED, 'utf8')); // 放行 + 污染 actor
  const rNet = run('plg', () => globalThis.fetch('http://203.0.113.7/x').catch(() => {}));
  check('S5', 'block 当场外发：凭据读取后联网被拦', !rCred.threw && rNet.threw && rNet.error?.code === 'DSH_PDR_BLOCKED', JSON.stringify({ cred: rCred.threw, net: rNet.error?.name }));
}

// ---------- ⑥ 本职零拦截（block 策略下自有 I/O 正常） ----------
{
  setup(deriveContract({ name: 'plg', capabilities: ['fs-read', 'fs-write'], manifest: { firewall: {} } }), BLOCK({ 'target-sensitive': 'block', 'target-other-plugin': 'block', 'destination-scope': 'block', 'capability-deviation': 'block' }));
  const r1 = run('plg', () => fs.readFileSync(path.join(DIR, 'own.json'), 'utf8'));
  const r2 = run('plg', () => fs.writeFileSync(path.join(DIR, 'own.json'), '{}'));
  check('S6', '本职零拦截：block 策略下自有目录读写不被误拦', !r1.threw && !r2.threw, JSON.stringify([r1.threw, r2.threw]));
}

// ---------- ⑦ fail-safe：拦截引擎异常 → 放行 ----------
{
  const judge = new Judge({});
  judge.registerPlugin('plg', DIR);
  judge.setContract('plg', deriveContract({ name: 'plg', capabilities: ['fs-read'], manifest: { firewall: {} } }));
  probe.configure({
    beforeCall: () => { throw new Error('engine blew up'); }, // 故意让引擎崩
  });
  const r = run('plg', () => fs.readFileSync(CRED, 'utf8'));
  check('S7', 'fail-safe：拦截引擎异常时放行不拦', !r.threw, r.error?.name);
  probe.configure({ beforeCall: null }); // 清理
}

// ---------- ⑧ 策略分层：插件覆盖 > 规则 ----------
{
  const policy = new Policy({ mode: 'alarm', rules: { 'target-sensitive': 'block' }, plugins: { plg: 'alarm' } });
  check('S8', '策略分层：插件覆盖压过规则 block', policy.decide('plg', 'target-sensitive') === 'alarm' && policy.decide('other', 'target-sensitive') === 'block');
}

rmSync(TMP, { recursive: true, force: true });
const metrics = {
  all: results.every((r) => r.pass),
  blocked: results.filter((r) => r.pass && /^S[2345]$/.test(r.id)).length,
  passed: results.filter((r) => r.pass).length,
  total: results.length,
};
report({ metrics, results });
