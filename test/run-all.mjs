/**
 * 一次跑完所有测试（CI 入口）。
 *
 * 设计要点：
 *   - **区分 PASS / SKIP / FAIL**：跳过不算通过，但也不该让 CI 红。
 *     输出里明确列出跳过了哪些、为什么跳过。
 *   - **默认串行**：这些测试会 hook 进程内的 fs/net 并落临时目录，
 *     并发跑会互相干扰（探针是进程级单例）。
 *   - 每个测试独立子进程，互不污染。
 *
 * 用法：
 *   node test/run-all.mjs            # 全部
 *   node test/run-all.mjs --only smoke,guard-eval
 *   node test/run-all.mjs --list
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 需要真实环境（真实插件/profile/外部数据集）的测试：缺环境时应 SKIP 而不是 FAIL */
const ENV_DEPENDENT = new Set([
  'm1-real-recall.mjs',
  'real-boot.mjs',
  'real-drive.mjs',
  'm2-falsepositive-eval.mjs',
  'm0-e2e-ab.mjs',
]);

const SLOW = new Set(['m0-overhead-correct.mjs', 'm0-overhead-fixed.mjs', 'm0-e2e-ab.mjs', 'real-boot.mjs']);

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only=')) ?? (argv.includes('--only') ? `--only=${argv[argv.indexOf('--only') + 1]}` : null);
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;

function collect() {
  const files = readdirSync(HERE, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mjs|cjs)$/.test(e.name))
    .map((e) => e.name)
    // 排除：本运行器、内部助手（_ 前缀）、一次性诊断脚本
    .filter((n) => !n.startsWith('_') && n !== 'run-all.mjs')
    .filter((n) => !/^(debug-secret|diag-facade|repro-cred|activate|m0-overhead-final)\./.test(n))
    .sort();
  return only ? files.filter((n) => only.has(n) || only.has(n.replace(/\.m?js$/, ''))) : files;
}

const files = collect();
if (argv.includes('--list')) {
  console.log(JSON.stringify(files, null, 2));
  process.exit(0);
}
if (!files.length) {
  console.error('没有匹配到测试文件');
  process.exit(1);
}

const results = [];
const t0 = Date.now();

for (const file of files) {
  const full = path.join(HERE, file);
  if (!existsSync(full)) continue;
  const started = Date.now();
  const r = spawnSync(process.execPath, [full], {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, NODE_OPTIONS: '' }, // 不让外层预载污染子进程
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Date.now() - started;

  let verdict = r.status === 0 ? 'PASS' : 'FAIL';
  let note = '';
  // 从 stdout 里认领"明确跳过"
  if (verdict === 'PASS' && /"skipped"\s*:\s*true/.test(r.stdout ?? '')) {
    verdict = 'SKIP';
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      note = j.reason ?? '';
    } catch { /* 忽略 */ }
  }
  if (verdict === 'FAIL') {
    const errTail = (r.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    note = r.signal ? `signal=${r.signal}` : (errTail || `exit=${r.status}`);
  }
  if (verdict === 'SKIP' && !ENV_DEPENDENT.has(file)) note = `（非环境依赖用例却跳过）${note}`;

  results.push({ file, verdict, ms, note });
  const tag = verdict === 'PASS' ? 'PASS' : verdict === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`  ${tag.padEnd(4)} ${file.padEnd(30)} ${String(ms).padStart(6)}ms  ${note.slice(0, 90)}`);
}

const summary = {
  total: results.length,
  pass: results.filter((r) => r.verdict === 'PASS').length,
  skip: results.filter((r) => r.verdict === 'SKIP').length,
  fail: results.filter((r) => r.verdict === 'FAIL').length,
  wallMs: Date.now() - t0,
  results,
};

console.log(JSON.stringify({ summary }, null, 2));
process.exitCode = summary.fail === 0 ? 0 : 1;
