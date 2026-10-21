/**
 * 调用内去重 + 三条路径目标归一 评测（真机实证缺陷的回归钉）
 *
 * 真机实测（research/第三方与红线验证-v0.md）暴露两个问题：
 *  ① 一次 fetch / http.request 在时间线里落**两条**事件（t 完全相同，只差 redLine 字段）；
 *     红线曾是"复制事件再 emit"，属调用内重复。
 *  ② net.connect 的目标记成 "[object Object]"，hostOf() 提不出 host，
 *     目的地越界判定（destination-scope）整条失效。
 *
 * 硬指标：
 *  A 单次 fetch 只记 1 条，且 redLines 含 cleartext-http（红线挂在同一事件上）
 *  B 漏报检查：红线规则本身不得因为去重而消失（getRedFlags 仍能看到）
 *  C 单次 http.request 只记 1 条（非本机地址 → 明文红线同事件）
 *  D 单次 net.connect 只记 1 条，且 target 归一为 tcp://host:port（不是 [object Object]）
 *  E 单次 spawn 只记 1 条
 *  F 凭据 → 联网：红线 credentials+network 记在同一事件上，事件数不翻倍
 *
 * 用法：node test/dedup-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const probe = req('../src/probe/probe-core.cjs');

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-dedup-'));
const DIR = path.join(TMP, 'dedup-plg');
mkdirSync(DIR, { recursive: true });
writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ name: 'dedup-plg', version: '1.0.0', type: 'module' }));
// 假凭据（不碰真实凭据）
const CRED = path.join(TMP, '.credentials.yaml');
writeFileSync(CRED, 'api-key: fake\n');

probe.install(); // 时序 A：探针先装

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

/** 在一次被归因的调用里跑 fn，返回期间新增的事件 */
async function measure(api, fn) {
  probe.reset();
  let threw = null;
  await probe.runAs('dedup-plg', async () => {
    try { await fn(); } catch (error) { threw = error; }
  });
  const events = probe.getEvents({ limit: 500 });
  return {
    said: events.filter((e) => (e.api ?? '').startsWith(api)),
    all: events,
    threw,
    redFlags: probe.getRedFlags(),
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- A/B fetch ----------
{
  const m = await measure('fetch', async () => {
    await fetch('http://203.0.113.7/dedup-fetch', { signal: AbortSignal.timeout(250) }).catch(() => {});
    await settle(60);
  });
  const evs = m.said.filter((e) => String(e.target).includes('dedup-fetch'));
  check('A', '单次 fetch 只记 1 条事件', evs.length === 1, `said=${evs.length} all=${m.all.length}`);
  const ev = evs[0];
  const rules = ev ? (Array.isArray(ev.redLines) ? ev.redLines : []) : [];
  check('A2', '红线挂在同一事件的 redLines 上（cleartext-http）', rules.includes('cleartext-http'), JSON.stringify(rules));
  const flagged = m.redFlags.filter((f) => f.rule === 'cleartext-http');
  check('B', '去重不丢红线：getRedFlags 仍能看到 cleartext-http', flagged.length >= 1, JSON.stringify(flagged.slice(0, 2)));
  check('B2', '红线条数 = 事件条数（不再翻倍）', flagged.length === evs.length, `redFlags=${flagged.length} events=${evs.length}`);
}

// ---------- C http.request ----------
{
  const m = await measure('http.request', async () => {
    await new Promise((res) => {
      const r = http.request({ host: '203.0.113.7', port: 80, path: '/dedup-http', method: 'GET', timeout: 250 }, () => res());
      r.on('error', res);
      r.on('timeout', () => { r.destroy(); res(); });
      r.end();
    });
    await settle(60);
  });
  const evs = m.said.filter((e) => String(e.target).includes('dedup-http'));
  check('C', '单次 http.request 只记 1 条事件', evs.length === 1, `said=${evs.length} all=${m.all.length}`);
  const rules = evs[0] && Array.isArray(evs[0].redLines) ? evs[0].redLines : [];
  check('C2', 'http.request 目标可读且带明文红线', !!evs[0] && rules.includes('cleartext-http'), `${evs[0]?.target} ${JSON.stringify(rules)}`);
}

// ---------- D net.connect ----------
{
  const m = await measure('net.connect', async () => {
    await new Promise((res) => {
      const s = net.connect({ host: '203.0.113.7', port: 81, timeout: 250 });
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', res);
      s.on('timeout', () => { s.destroy(); res(); });
    });
    await settle(60);
  });
  const evs = m.said;
  check('D', '单次 net.connect 只记 1 条事件', evs.length === 1, `said=${evs.length} all=${m.all.length}`);
  const target = String(evs[0]?.target ?? '');
  check('D2', 'target 归一为 tcp://host:port（不是 [object Object]）',
    target === 'tcp://203.0.113.7:81', target);
  check('D3', 'hostOf 能从归一目标提取 host（目的地越界判定可用）',
    (() => { try { return new URL(target).hostname === '203.0.113.7'; } catch { return false; } })(), target);
}

// ---------- E spawn ----------
{
  // 注意：不能在文件顶部 `import { spawn }`——ESM 具名导入在 install() 之前就把函数值固化了
  // （真机 facade 时序 B 的同款问题）。这里在 install 之后取，才是被包装的那份。
  const { spawn } = req('node:child_process');
  const m = await measure('child_process.spawn', async () => {
    await new Promise((res) => {
      const p = spawn('cmd', ['/c', 'echo dedup-spawn'], { stdio: 'ignore' });
      p.on('exit', res);
      p.on('error', res);
    });
    await settle(60);
  });
  const evs = m.said.filter((e) => String(e.target).includes('dedup-spawn'));
  check('E', '单次 spawn 只记 1 条事件', evs.length === 1, `said=${evs.length} all=${m.all.length}`);
}

// ---------- G https.request → tls.connect（真机新发现路径） ----------
{
  const m = await measure('https.request', async () => {
    await new Promise((res) => {
      const r = https.request({ host: '203.0.113.7', port: 443, path: '/dedup-tls', method: 'GET', timeout: 250 }, () => res());
      r.on('error', res);
      r.on('timeout', () => { r.destroy(); res(); });
      r.end();
    });
    await settle(60);
  });
  const evs = m.said.filter((e) => String(e.target).includes('dedup-tls'));
  check('G', '单次 https.request 只记 1 条（tls.connect 嵌套已去重）', evs.length === 1, `said=${evs.length} all=${m.all.length}`);
  check('G2', 'https.request 目的地可读', evs[0]?.target === 'https://203.0.113.7/dedup-tls', evs[0]?.target);
}

// ---------- H tls.connect 单独调用也被覆盖 ----------
{
  const { connect: tlsConnect } = req('node:tls');
  const m = await measure('tls.connect', async () => {
    await new Promise((res) => {
      const s = tlsConnect({ host: '203.0.113.7', port: 444, timeout: 250, rejectUnauthorized: false });
      s.on('secureConnect', () => { s.destroy(); res(); });
      s.on('error', res);
      s.on('timeout', () => { s.destroy(); res(); });
    });
    await settle(60);
  });
  const evs = m.said;
  check('H', '单次 tls.connect 记 1 条且目标归一', evs.length === 1 && evs[0].target === 'tcp://203.0.113.7:444',
    `said=${evs.length} target=${evs[0]?.target}`);
}

// ---------- I net.connect 的三种调用形态都要归对（漏一种就是绕过口） ----------
{
  const forms = [
    ['对象形态', () => net.connect({ host: '203.0.113.7', port: 81 }), 'tcp://203.0.113.7:81'],
    ['位置参数形态', () => net.connect(81, '203.0.113.7'), 'tcp://203.0.113.7:81'],
    ['命名管道形态', () => net.connect('\\\\.\\pipe\\dsh-dedup'), 'pipe://\\\\.\\pipe\\dsh-dedup'],
  ];
  for (const [label, mk, expect] of forms) {
    const m = await measure('net.connect', async () => {
      const s = mk();
      s.on('error', () => {});
      s.on('timeout', () => s.destroy());
      await settle(30);
      s.destroy();
    });
    const evs = m.said;
    check('I-' + label, `${label}目标归一`, evs.length === 1 && evs[0].target === expect,
      `said=${evs.length} target=${evs[0]?.target}`);
  }
}

// ---------- F 凭据 + 联网组合 ----------
{
  probe.reset();
  const fs = req('node:fs');
  await probe.runAs('dedup-plg', async () => {
    try { fs.readFileSync(CRED, 'utf8'); } catch { /* ignore */ }
    await fetch('http://203.0.113.7/dedup-exfil', { signal: AbortSignal.timeout(250) }).catch(() => {});
    await settle(80);
  });
  const events = probe.getEvents({ limit: 500 });
  const fetches = events.filter((e) => e.api === 'fetch' && String(e.target).includes('dedup-exfil'));
  const rules = fetches[0] && Array.isArray(fetches[0].redLines) ? fetches[0].redLines : [];
  check('F', '凭据后联网：fetch 仍只有 1 条事件', fetches.length === 1, `fetches=${fetches.length}`);
  check('F2', 'credentials+network 记在同一事件上', rules.includes('credentials+network'), JSON.stringify(rules));
  const flagged = probe.getRedFlags().filter((f) => f.rule === 'credentials+network');
  check('F3', '组合红线仍可被 getRedFlags 检索到', flagged.length >= 1, `count=${flagged.length}`);
}

rmSync(TMP, { recursive: true, force: true });
report({ all: results.every((r) => r.pass), results });
