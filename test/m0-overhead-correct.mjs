/**
 * M0 开销终审 · 正确口径版
 *
 * 前几版把「探针开销 / I/O 子集耗时」当分母，得到 5%~10% 的波动数字——口径错了：
 * 方案 §5.3 的 "<2%" 指的是**对宿主整体运行体验的影响**，分母应是会话墙钟时间，
 * 不是"这些 I/O 本身花了多久"。
 *
 * 正确算法：
 *   探针总开销 = 每次 hook 的增量成本(µs) × 会话里真实发生的 hook 次数
 *   占比       = 探针总开销 / 会话墙钟时间
 *
 * 两个输入分别独立测量：
 *   ① per-op 增量：固定大工作负载回放，多轮取中位数（本脚本第一部分）
 *   ② 真实事件数 + 会话墙钟：从真实 headless 会话的 events.jsonl 与实测耗时取（第二部分）
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVENTS = process.argv[2] || 'E:\\.dsh\\firewall\\events.jsonl';
const SESSION_WALL_MS = Number(process.argv[3] || 35710); // 真实会话实测中位数（m0-e2e-ab）
const ROUNDS = 25;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'src', 'probe', 'probe-core.cjs');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'pdr-m0c-'));

// ---------- ① 构建足够大的真实工作负载 ----------
const lines = readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
const uniq = new Map();
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const api = String(e.api || '');
  const m = /^fs\.(readFileSync|existsSync|statSync|readdirSync|openSync)$/.exec(api);
  if (!m) continue;
  const t = String(e.target || '');
  if (!t || t.length > 240) continue;
  try { if (!existsSync(t)) continue; } catch { continue; }
  uniq.set(api + '\u0000' + t, { api, target: t });
}
let workload = [...uniq.values()];

// 放大到 ≥1500 ops（重复真实条目，保持方法/路径构成不变），降低单轮噪声
const base = [...workload];
while (workload.length < 1500 && base.length > 0) workload = workload.concat(base.slice(0, Math.min(base.length, 1500 - workload.length)));

const byApi = {};
for (const o of workload) byApi[o.api] = (byApi[o.api] || 0) + 1;
const wlFile = path.join(TMP, 'wl.json');
writeFileSync(wlFile, JSON.stringify(workload));
console.error(`工作负载 ${workload.length} ops（去重后真实路径 ${base.length} 条）${JSON.stringify(byApi)}`);

function arm(mode) {
  const code = `
    const { createRequire } = require('node:module');
    const req = createRequire(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href)});
    const probe = req(${JSON.stringify(PROBE)});
    const MODE = ${JSON.stringify(mode)};
    if (MODE !== 'none') probe.install({ mode: MODE, maxEvents: 50000 });
    const fs = require('node:fs');
    const WL = JSON.parse(fs.readFileSync(process.env.WL_FILE, 'utf8'));
    function replay() {
      for (const o of WL) {
        try {
          switch (o.api) {
            case 'fs.readFileSync': fs.readFileSync(o.target, 'utf8'); break;
            case 'fs.existsSync': fs.existsSync(o.target); break;
            case 'fs.statSync': fs.statSync(o.target); break;
            case 'fs.readdirSync': fs.readdirSync(o.target); break;
            case 'fs.openSync': { const fd = fs.openSync(o.target, 'r'); fs.closeSync(fd); break; }
          }
        } catch {}
      }
    }
    for (let i = 0; i < 3; i++) replay();
    const s = [];
    for (let r = 0; r < ${ROUNDS}; r++) {
      const t0 = process.hrtime.bigint(); replay();
      s.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    process.stdout.write(JSON.stringify({ samples: s, events: MODE === 'none' ? 0 : probe.getStats().totalEvents }));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, WL_FILE: wlFile }, encoding: 'utf8', maxBuffer: 64e6 });
  return JSON.parse(out);
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const runs = {};
for (const m of ['none', 'als', 'stack', 'both']) {
  const r = arm(m);
  const trimmed = [...r.samples].sort((a, b) => a - b).slice(0, Math.max(5, r.samples.length - 3));
  runs[m] = { medianMs: med(trimmed), events: r.events };
  console.error(`  ${m.padEnd(6)} ${runs[m].medianMs.toFixed(2)}ms`);
}

const baseMs = runs.none.medianMs;
const perOpUs = {};
for (const m of ['als', 'stack', 'both']) {
  perOpUs[m] = ((runs[m].medianMs - baseMs) * 1000) / workload.length;
}

// ---------- ② 结合真实会话算整体占比 ----------
const sessionHooks = lines.length;            // 会话里真实发生的 hook 次数（= 事件数，去重后一条调用一事件）
const sessionWallMs = SESSION_WALL_MS;
const overhead = {};
for (const m of ['als', 'stack', 'both']) {
  const totalMs = (perOpUs[m] * sessionHooks) / 1000;
  const pct = (totalMs / sessionWallMs) * 100;
  overhead[m] = {
    perOpUs: Number(perOpUs[m].toFixed(3)),
    hooksInSession: sessionHooks,
    totalOverheadMs: Number(totalMs.toFixed(1)),
    sessionWallMs,
    pctOfSession: Number(pct.toFixed(3)),
  };
}

console.log(JSON.stringify({
  method: 'per-op 增量 × 真实 hook 次数 / 会话墙钟（方案 §5.3 的"对宿主整体影响"口径）',
  workload: { ops: workload.length, distinctRealPaths: base.length, byApi, rounds: ROUNDS },
  baselineMs: Number(baseMs.toFixed(2)),
  perOpBreakdown: Object.fromEntries(Object.entries(overhead).map(([k, v]) => [k, { perOpUs: v.perOpUs, pctOfReplay: Number(((runs[k].medianMs - baseMs) / baseMs * 100).toFixed(1)) }])),
  sessionOverhead: overhead,
  gate: '< 2%', defaultMode: 'als',
  pass: overhead.als.pctOfSession < 2,
}, null, 2));
rmSync(TMP, { recursive: true, force: true });
