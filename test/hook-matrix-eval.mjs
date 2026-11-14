/**
 * v0.3 §4.4：Hook 覆盖矩阵（机器可读，进 CI）
 *
 * 目标不是"证明覆盖很全"，而是把**已知缺口也变成可断言的测试结果**。
 * 矩阵按插件消费 API 的方式分组（CJS require / ESM default / namespace / named /
 * 预载前固化引用），每个组合都真的跑一遍，读回事件流判定有没有被观测到。
 *
 * 实测结论（本文件断言的就是这个事实）：
 *   - 有预载时，四种 import 消费方式 **全部** 被覆盖（含 ESM 具名导入）；
 *   - 没有预载、引用在安装前固化的场景（等价于"晚装"），
 *     fs 同步读与 child_process **缺失** —— 这正是必须坚持预载的原因。
 *
 * 若将来某项能力变化（补上了或退化了），这个测试会红，逼着矩阵同步更新，
 * 而不是让缺口只留在设计文档里。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from './_report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRELOAD = path.join(ROOT, 'src', 'probe', 'preload.cjs');
const PROBE = path.join(ROOT, 'src', 'probe', 'probe-core.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdr-matrix-'));
const RUNNER = path.join(TMP, 'runner.cjs');
const TARGET = path.join(ROOT, 'package.json');

/**
 * 子进程脚本：按 style 用不同方式调用同一批 API，然后把事件流写出来。
 * 注意 Windows 上 execSync 的命令行必须自己加引号（可执行路径含空格）。
 */
const RUNNER_SRC = String.raw`
const style = process.env.MX_STYLE;
const target = process.env.MX_TARGET;
const out = process.env.MX_OUT;
const probePath = process.env.MX_PROBE;

// 预载前固化引用：等价于 ESM 具名导入在 facade 创建时把函数值拷走
let cap = null;
if (style === 'captured-before-install') {
  const fsMod = require('node:fs');
  const cpMod = require('node:child_process');
  cap = { readFileSync: fsMod.readFileSync, execSync: cpMod.execSync };
}

const probe = require(probePath);
if (!probe.isInstalled()) probe.install({ mode: 'als' });
probe.reset();

const closed = 'http://127.0.0.1:9/matrix';
const NODE = JSON.stringify(process.execPath);

function hitHttp(request) {
  const r = request(closed);
  r.on('error', () => {});
  r.end();
  try { r.destroy(); } catch {}
}

async function main() {
  if (style === 'cjs') {
    require('node:fs').readFileSync(target);
    await require('node:fs/promises').readFile(target);
    require('node:child_process').execSync(NODE + ' -e 0');
    hitHttp(require('node:http').request);
    await fetch(closed).catch(() => {});
  } else if (style === 'esm-default') {
    const fs = (await import('node:fs')).default;
    fs.readFileSync(target);
    const fsp = (await import('node:fs/promises')).default;
    await fsp.readFile(target);
    const cp = (await import('node:child_process')).default;
    cp.execSync(NODE + ' -e 0');
    const http = (await import('node:http')).default;
    hitHttp(http.request);
    await fetch(closed).catch(() => {});
  } else if (style === 'esm-namespace') {
    const fs = await import('node:fs');
    fs.readFileSync(target);
    const fsp = await import('node:fs/promises');
    await fsp.readFile(target);
    const cp = await import('node:child_process');
    cp.execSync(NODE + ' -e 0');
    const http = await import('node:http');
    hitHttp(http.request);
    await fetch(closed).catch(() => {});
  } else if (style === 'esm-named') {
    const { readFileSync } = await import('node:fs');
    readFileSync(target);
    const { readFile } = await import('node:fs/promises');
    await readFile(target);
    const { execSync } = await import('node:child_process');
    execSync(NODE + ' -e 0');
    const { request } = await import('node:http');
    hitHttp(request);
    await fetch(closed).catch(() => {});
  } else if (style === 'captured-before-install') {
    cap.readFileSync(target);
    cap.execSync(NODE + ' -e 0');
    hitHttp(require('node:http').request);
    await fetch(closed).catch(() => {});
  }
}

main().catch(() => {}).then(() => {
  setTimeout(() => {
    const stats = probe.getStats();
    const events = probe.getEvents({ limit: 500 }).map((e) => ({ api: e.api, actor: e.actor }));
    require('node:fs').writeFileSync(out, JSON.stringify({ events, stats }));
  }, 250);
});
`;
fs.writeFileSync(RUNNER, RUNNER_SRC);

/** 事件 API 名 -> 能力族 */
const FAMILIES = {
  'fs-sync': (api) => api === 'fs.readFileSync' || api === 'fs.readFileUtf8' || api === 'fs.binding.open',
  'fs-async': (api) => api.startsWith('fs.promises.'),
  'child_process': (api) => api.startsWith('child_process.'),
  'http': (api) => api.startsWith('http.'),
  'net': (api) => api.startsWith('net.') || api.startsWith('tls.'),
  'fetch': (api) => api === 'fetch',
};
const ALL = ['fs-sync', 'fs-async', 'child_process', 'http', 'fetch'];

/**
 * 矩阵期望：preload=true 时四种 import 风格应全覆盖；
 * captured-before-install 是有预载缺口时的真实残余（fs 同步读 + 子进程丢掉）。
 */
const CASES = [
  { id: 'cjs', label: 'CommonJS require()', preload: true, expect: ALL, gap: [] },
  { id: 'esm-default', label: 'ESM default import', preload: true, expect: ALL, gap: [] },
  { id: 'esm-namespace', label: 'ESM namespace import', preload: true, expect: ALL, gap: [] },
  { id: 'esm-named', label: 'ESM named import', preload: true, expect: ALL, gap: [] },
  { id: 'captured-before-install', label: '预载前固化引用（= 晚装）', preload: false, expect: ['http', 'fetch'], gap: ['fs-sync', 'child_process'] },
];

function runCase(c) {
  const home = fs.mkdtempSync(path.join(TMP, `home-${c.id}-`));
  const out = path.join(TMP, `out-${c.id}.json`);
  const env = {
    ...process.env,
    DSH_HOME: home,
    MX_STYLE: c.id,
    MX_TARGET: TARGET,
    MX_OUT: out,
    MX_PROBE: PROBE,
    // preload=true 用真实注入路径；false 模拟"没有预载，只在插件里晚装"
    NODE_OPTIONS: c.preload ? `--require "${PRELOAD.replace(/\\/g, '/')}"` : '',
  };
  const r = spawnSync(process.execPath, [RUNNER], { env, encoding: 'utf8', timeout: 60_000 });
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { parsed = null; }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  try { fs.rmSync(out, { force: true }); } catch { /* 清理失败忽略 */ }
  const events = parsed?.events ?? [];
  const apis = [...new Set(events.map((e) => e.api))];
  const seen = Object.entries(FAMILIES).filter(([, f]) => apis.some(f)).map(([k]) => k);
  const missing = c.expect.filter((f) => !seen.includes(f));
  const unexpected = c.gap.filter((f) => seen.includes(f));
  return {
    ok: r.status === 0 && !!parsed && missing.length === 0 && unexpected.length === 0,
    status: r.status,
    apis,
    seen,
    missing,
    unexpected,
    doubleWrapped: parsed?.stats?.doubleWrapped ?? null,
    actor: events.length ? events[0].actor : null,
    stderr: (r.stderr || '').trim().split('\n').slice(-2).join(' | '),
  };
}

const results = [];
const details = [];
for (const c of CASES) {
  const got = runCase(c);
  let detail = `seen=[${got.seen.join(',')}]`;
  if (got.missing.length) detail += ` missing=[${got.missing.join(',')}]`;
  if (got.unexpected.length) detail += ` unexpectedly-covered=[${got.unexpected.join(',')}]`;
  if (got.doubleWrapped) detail += ` doubleWrapped=${got.doubleWrapped}`;
  if (got.stderr) detail += ` stderr=${got.stderr}`;
  details.push([c.id, detail]);
  results.push({ id: c.id, label: c.label, pass: got.ok && !got.doubleWrapped, detail });
}

const passed = results.filter((r) => r.pass).length;

report({
  all: passed === results.length,
  passed,
  total: results.length,
  matrix: CASES.map((c, i) => ({ style: c.id, preload: c.preload, expect: c.expect, gap: c.gap, detail: results[i].detail })),
  results,
});

// 说明（stderr，不污染 JSON）
for (const [id, d] of details) console.error(`  ${id.padEnd(24)} ${d}`);
