/**
 * M0 开销终审：固定工作负载（1552 个真实只读操作），三模式对比，多轮取中位数。
 * 前几轮结果波动大，根因是工作负载只有几百个操作、单轮耗时才 30ms，噪声占比过高。
 * 这里固化负载 + 提高轮次 + 报告置信区间（min/max/p25/p75）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EVENTS = process.argv[2] || 'E:\\.dsh\\firewall\\events.jsonl';
const ROUNDS = Number(process.argv[3] || 15);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'src', 'probe', 'probe-core.cjs');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pdr-m0f-'));
const lines = readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
const uniq = new Map();
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const api = String(e.api || '');
  if (!/^fs\.(readFileSync|existsSync|statSync|readdirSync|openSync)$/.test(api)) continue;
  const t = String(e.target || '');
  if (!t || t.length > 240) continue;
  try { if (!existsSync(t)) continue; } catch { continue; }
  uniq.set(api + '\u0000' + t, { api, target: t });
}
const workload = [...uniq.values()];
const wlFile = path.join(TMP, 'wl.json');
writeFileSync(wlFile, JSON.stringify(workload));

const byApi = {};
for (const o of workload) byApi[o.api] = (byApi[o.api] || 0) + 1;
console.error(`工作负载：${workload.length} ops ${JSON.stringify(byApi)}`);

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
    let ev = 0;
    if (MODE !== 'none') ev = probe.getStats().totalEvents;
    process.stdout.write(JSON.stringify({ samples: s, events: ev }));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, WL_FILE: wlFile }, encoding: 'utf8', maxBuffer: 64e6 });
  return JSON.parse(out);
}

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stat = (xs) => ({ median: q(xs, 0.5), p25: q(xs, 0.25), p75: q(xs, 0.75), min: q(xs, 0), max: q(xs, 1) });

const modes = ['none', 'als', 'stack', 'both'];
const res = {};
for (const m of modes) {
  const r = arm(m);
  // 剔除前两个最慢的离群（首次 GC / 页缓存抖动）
  const trimmed = [...r.samples].sort((a, b) => a - b).slice(0, Math.max(3, r.samples.length - 2));
  res[m] = { ...stat(trimmed), events: r.events, raw: r.samples.map((n) => Number(n.toFixed(2))) };
  console.error(`  ${m.padEnd(6)} median=${res[m].median.toFixed(2)}ms events=${r.events}`);
}

const base = res.none.median;
const summary = {};
for (const m of modes) {
  summary[m] = {
    medianMs: Number(res[m].median.toFixed(2)),
    deltaPct: m === 'none' ? 0 : Number(((res[m].median - base) / base * 100).toFixed(2)),
  };
}

console.log(JSON.stringify({
  method: '固定真实工作负载回放（每臂独立子进程，预热 3 轮，正式 N 轮，剔除 2 个最慢离群）',
  workload: { source: EVENTS, ops: workload.length, byApi, roundsPerArm: ROUNDS },
  summary,
  detail: res,
  gate: '< 2%', defaultMode: 'als',
  pass: summary.als.deltaPct < 2,
}, null, 2));
rmSync(TMP, { recursive: true, force: true });
