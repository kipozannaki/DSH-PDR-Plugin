/**
 * M0 开销终审 · 整机会话 A/B（旁证口径）
 *
 * 主口径见 test/m0-overhead-final.mjs（真实工作负载回放，低噪、可判定 <2%）。
 * 本脚本给整机旁证：真实 headless 会话端到端 wall time，A(不装)/B(装探针) 交替多轮取中位数。
 *
 * 局限（必须如实标注）：端到端时间被模型 API 往返主导（秒级），探针开销是毫秒级，
 * 信噪比低——所以这里只回答"有没有灾难性回归"，不用于 <2% 判定。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const { execFileSync } = req('node:child_process');

const ROUNDS = Number(process.argv[2] || 4);
const PROMPT = 'Reply with exactly: m0-e2e';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'bin', 'dsh-pdr.cjs');
const PRELOAD = '--require "E:/.dsh/profiles/pdr-hl/node_modules/dsh-pdr-plugin/src/probe/preload.cjs"';

function runOnce(withProbe) {
  const env = { ...process.env, PDR_PROBE_MODE: withProbe ? 'als' : '' };
  if (withProbe) env.NODE_OPTIONS = PRELOAD; else delete env.NODE_OPTIONS;
  const t0 = process.hrtime.bigint();
  let exit = 0;
  try {
    execFileSync(process.execPath, [LAUNCHER, '--profile', 'pdr-hl', '--patch', 'E:/chat/.verify/enable-creds.yml', PROMPT],
      { env, stdio: 'ignore', cwd: 'E:\\chat\\dsh-pdr-plugin', timeout: 180000 });
  } catch (e) { exit = e.status ?? 1; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, exit };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const A = [], B = [];
for (let i = 0; i < ROUNDS; i++) {
  // 交替，抵消时钟漂移 / 网络状态变化
  const a = runOnce(false); A.push(a.ms);
  process.stderr.write(`  A(no-probe) r${i + 1}: ${Math.round(a.ms)}ms exit=${a.exit}\n`);
  const b = runOnce(true); B.push(b.ms);
  process.stderr.write(`  B(probe)    r${i + 1}: ${Math.round(b.ms)}ms exit=${b.exit}\n`);
}

const medA = median(A), medB = median(B);
const pct = ((medB - medA) / medA) * 100;
console.log(JSON.stringify({
  method: '整机 headless 会话端到端（旁证口径，噪声大，不用于 <2% 判定）',
  rounds: ROUNDS,
  armA_noProbe: { samplesMs: A.map((n) => Math.round(n)), medianMs: Math.round(medA) },
  armB_probe: { samplesMs: B.map((n) => Math.round(n)), medianMs: Math.round(medB) },
  deltaMs: Math.round(medB - medA),
  deltaPct: Math.round(pct * 100) / 100,
  caveat: '端到端被模型 API 往返主导，绝对值不可比；仅确认无数量级回归',
}, null, 2));
