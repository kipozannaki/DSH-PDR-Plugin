/**
 * M0 开销终审 · 整机会话 A/B（旁证口径）
 *
 * 主口径见 test/m0-overhead-correct.mjs（真实工作负载回放，低噪、可判定 <2%）。
 * 本脚本给整机旁证：真实 headless 会话端到端 wall time，A(不装)/B(装探针) 交替多轮取中位数。
 *
 * 局限（必须如实标注）：端到端时间被模型 API 往返主导（秒级），探针开销是毫秒级，
 * 信噪比低——所以这里只回答"有没有灾难性回归"，不用于 <2% 判定。
 *
 * 需要真实环境：一个已装好本插件、且能跑通模型请求的 DSH profile。
 *   PDR_E2E_PROFILE   profile 名（必填，没有就跳过）
 *   PDR_E2E_PATCH     可选的 patch 文件（例如启用凭据服务的测试补丁）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { report, skip } from './_report.mjs';

const req = createRequire(import.meta.url);
const { execFileSync } = req('node:child_process');

const ROUNDS = Number(process.argv[2] || 4);
const PROMPT = 'Reply with exactly: m0-e2e';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'bin', 'dsh-pdr.cjs');

const PROFILE = process.env.PDR_E2E_PROFILE;
const PATCH = process.env.PDR_E2E_PATCH;

if (!PROFILE) {
  skip(
    '整机 A/B 需要真实 DSH profile（会真的发起模型请求）',
    '设 PDR_E2E_PROFILE=<profile名>（可选 PDR_E2E_PATCH=<patch.yml>），再跑 node test/m0-e2e-ab.mjs',
  );
}

// 预载指向**目标 profile 里安装的那一份**（与 dsh-pdr 启动器同一解析逻辑）
const dshHome = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const PRELOAD = `--require "${path.join(dshHome, 'profiles', PROFILE, 'node_modules', 'dsh-pdr-plugin', 'src', 'probe', 'preload.cjs').replace(/\\/g, '/')}"`;

function runOnce(withProbe) {
  const env = { ...process.env, PDR_PROBE_MODE: withProbe ? 'als' : '' };
  if (withProbe) env.NODE_OPTIONS = PRELOAD; else delete env.NODE_OPTIONS;
  const args = [LAUNCHER, '--profile', PROFILE];
  if (PATCH) args.push('--patch', PATCH);
  args.push(PROMPT);
  const t0 = process.hrtime.bigint();
  let exit = 0;
  try {
    execFileSync(process.execPath, args, { env, stdio: 'ignore', cwd: ROOT, timeout: 180000 });
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
const out = {
  method: '整机 headless 会话端到端（旁证口径，噪声大，不用于 <2% 判定）',
  profile: PROFILE,
  rounds: ROUNDS,
  armA_noProbe: { samplesMs: A.map((n) => Math.round(n)), medianMs: Math.round(medA) },
  armB_probe: { samplesMs: B.map((n) => Math.round(n)), medianMs: Math.round(medB) },
  deltaMs: Math.round(medB - medA),
  deltaPct: Math.round(pct * 100) / 100,
  caveat: '端到端被模型 API 往返主导，绝对值不可比；仅确认无数量级回归',
};
// 旁证只回答"有没有灾难性回归"：设一个很宽的界，避免把噪声当成失败
out.ok = Math.abs(out.deltaPct) < 100;
report(out);
