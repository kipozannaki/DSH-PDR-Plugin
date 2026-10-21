/**
 * 安全中心 HTTP 契约（单一来源）
 *
 * serve.js（独立预览桥）与 host-web.js（宿主 dsh-h3 挂载）共用同一套路由/handler，
 * 保证"预览里能用的，在宿主里就是同一份行为"。
 *
 * 契约（app.js 与审计工具依赖的稳定面）：
 *   GET /api/firewall/overview   汇总（插件+信任分+红线+探针状态）
 *   GET /api/firewall/events     行为时间线（?actor=&flag=&q=&limit=）
 *   GET /api/firewall/redflags   红线告警
 *   GET /api/firewall/export     审计报告 JSON（attachment）
 *   GET /firewall/               安全中心面板（+ /firewall/app.js、/firewall/style.css）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoData } from './demo-data.mjs';
import { trustScore } from '../inspector/trust-score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 数据源 ----------
/** 离线数据源：JSONL 回放（真实探针日志）或演示数据 */
export function createDataSource({ jsonlPath = null } = {}) {
  function loadRealData() {
    const events = [];
    for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 忽略坏行 */ }
    }
    const redFlags = [];
    for (const e of events) {
      const rules = Array.isArray(e.redLines) ? e.redLines : (e.redLine ? [e.redLine] : []);
      for (const rule of rules) redFlags.push({ rule, t: e.t, actor: e.actor, api: e.api, target: e.target });
    }
    const byActor = new Map();
    for (const e of events) {
      const row = byActor.get(e.actor) || { name: e.actor, version: '', verdict: 'PASS', capabilities: [], redLines: [], behavior: { total: 0, network: 0, fs: 0, subprocess: 0, credentials: 0 } };
      row.behavior.total++;
      if (/^https?:|^fetch|^net\.|^(http|https)\./.test(e.api)) row.behavior.network++;
      else if (e.api.startsWith('child_process')) row.behavior.subprocess++;
      else row.behavior.fs++;
      if (e.flags?.includes('credentials-access')) row.behavior.credentials++;
      byActor.set(e.actor, row);
    }
    for (const f of redFlags) {
      const row = byActor.get(f.actor);
      if (row && !row.redLines.includes(f.rule)) row.redLines.push(f.rule);
      if (row) row.verdict = 'BLOCK';
    }
    return {
      demo: false,
      generatedAt: Date.now(),
      plugins: [...byActor.values()],
      events,
      redFlags,
      stats: { installed: true, mode: 'both', totalEvents: events.length, stored: events.length, dropped: 0, errors: 0 },
    };
  }

  const raw = () => (jsonlPath ? loadRealData() : buildDemoData());
  return {
    kind: jsonlPath ? 'jsonl' : 'demo',
    getOverview: () => withTrust(raw()),
    getEvents: (query) => filterEvents(raw(), query),
    getRedFlags: () => raw().redFlags,
    getReport: () => buildReport(raw()),
  };
}

/** 在线数据源：真实防火墙 API（宿主内挂载时用） */
export function createLiveSource(api) {
  const build = () => {
    const redFlags = api.getRedFlags();
    const summary = api.getSummary();
    const verdicts = api.getVerdicts ? api.getVerdicts() : [];
    const vByActor = new Map(verdicts.map((v) => [v.actor, v]));
    const rulesByActor = new Map();
    for (const f of redFlags) {
      const list = rulesByActor.get(f.actor) ?? [];
      if (!list.includes(f.rule)) list.push(f.rule);
      rulesByActor.set(f.actor, list);
    }
    return {
      demo: false,
      generatedAt: Date.now(),
      redFlags,
      stats: summary.stats,
      plugins: summary.actors.map((a) => {
        const redLines = rulesByActor.get(a.actor) ?? [];
        const v = vByActor.get(a.actor);
        return {
          name: a.actor, version: '', capabilities: [], redLines,
          verdict: redLines.length ? 'BLOCK' : 'PASS',
          judge: v ? {
            verdict: v.verdict, zh: v.zh,
            violations: (v.violations ?? []).slice(0, 4).map((x) => ({ rule: x.rule, severity: x.severity, detail: x.detail })),
          } : null,
          behavior: a,
        };
      }),
      events: api.getEvents({ limit: 1000 }),
    };
  };
  return {
    kind: 'live',
    getOverview: () => withTrust(build()),
    getEvents: (query) => ({ events: api.getEvents(query) }),
    getRedFlags: () => api.getRedFlags(),
    getReport: () => buildReport(build()),
  };
}

function withTrust(raw) {
  raw.plugins = (raw.plugins ?? []).map((p) => ({
    ...p,
    trust: trustScore({ redLines: p.redLines ?? [], behavior: p.behavior ?? {}, capabilities: p.capabilities ?? [] }),
  }));
  return raw;
}

function filterEvents(raw, query = {}) {
  let events = raw.events ?? [];
  if (query.actor) events = events.filter((e) => e.actor === query.actor);
  if (query.flag === 'redline') {
    const key = new Set((raw.redFlags ?? []).map((f) => `${f.actor}|${f.api}|${f.target}`));
    events = events.filter((e) => key.has(`${e.actor}|${e.api}|${e.target}`));
  } else if (query.flag) {
    events = events.filter((e) => e.flags?.includes(query.flag));
  }
  const q = String(query.q ?? '').toLowerCase();
  if (q) events = events.filter((e) => (e.target || '').toLowerCase().includes(q) || (e.api || '').toLowerCase().includes(q));
  return { events: [...events].sort((a, b) => b.t - a.t).slice(0, Number(query.limit) || 200) };
}

function buildReport(raw) {
  return {
    title: 'DSH-PDR-Plugin 审计报告',
    generatedAt: new Date().toISOString(),
    demo: !!raw.demo,
    disclaimer: '判定为启发式辅助（静态能力面 + 运行时行为 + 红线组合），不替代人工审查；数据仅存本机。',
    summary: { plugins: raw.plugins ?? [], redFlags: raw.redFlags ?? [], stats: raw.stats ?? {} },
    events: (raw.events ?? []).slice(0, 1000),
  };
}

// ---------- 路由表（handler 纯函数：入参 query，出参 {status,type,headers?,body}） ----------
function json(body, headers) {
  return { status: 200, type: 'application/json; charset=utf-8', headers, body: JSON.stringify(body) };
}

export function createRoutes({ source }) {
  return [
    {
      method: 'GET', path: '/api/firewall/overview',
      handle: (query) => json({ ...source.getOverview(), events: undefined }),
    },
    {
      method: 'GET', path: '/api/firewall/events',
      handle: (query) => json(source.getEvents(query)),
    },
    {
      method: 'GET', path: '/api/firewall/redflags',
      handle: () => json({ redFlags: source.getRedFlags() }),
    },
    {
      method: 'GET', path: '/api/firewall/export',
      handle: () => json(source.getReport(), { 'content-disposition': 'attachment; filename="dsh-firewall-audit.json"' }),
    },
    { method: 'GET', path: '/firewall', handle: () => asset('index.html') },
    { method: 'GET', path: '/firewall/', handle: () => asset('index.html') },
    { method: 'GET', path: '/firewall/app.js', handle: () => asset('app.js') },
    { method: 'GET', path: '/firewall/style.css', handle: () => asset('style.css') },
  ];
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function asset(name) {
  return {
    status: 200,
    type: MIME[path.extname(name)] ?? 'application/octet-stream',
    body: readFileSync(path.join(HERE, name)),
  };
}
