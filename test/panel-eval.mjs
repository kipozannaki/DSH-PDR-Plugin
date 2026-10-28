/**
 * 行为监控面板评测
 *
 *  A 宿主路由：connection.fetch.register 以 POST + buffered 形状注册 /api/dsh-pdr/*，
 *    且注册包在 ctx.effect 里（fiber 卸载时自动撤销）
 *  B events 路由：透传 actor/flag/q/limit，返回 { ok:true, value:{events:[…]} }
 *  C overview 路由：插件画像（total/network/fs/subprocess/credentials）+ 红线 + 判定 + 探针健康
 *  D 数据顺序：events 按 t 倒序（面板直接渲染，不再排序）
 *  E connection 缺位：ok:false + reason，绝不抛错影响主功能
 *  F 数据未装配（api 未 bind）：明确的 not-ready，而不是 undefined
 *  G client bundle：与宿主 ModuleLoader 相同的装载形态下，apply 注册
 *    conversation.view 槽位（id=pdr-monitor, order=30）
 *  H client 零依赖：不 require react 以外的东西（宿主只保证 react/primitives）
 *
 * 用法：node test/panel-eval.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const probe = req('../src/probe/probe-core.cjs');

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

// ---------- 真实探针 + 真实数据 ----------
probe.install({ mode: 'als' });
probe.reset();
probe.registerPlugin('panel-plg', path.join(HERE, 'fixtures', 'victim'));

// ---------- mock connection.fetch（新契约：服务经 ctx.inject 的注入上下文取）----------
const registered = [];
const effectsRan = [];
function makeCtx({ withConnection = true } = {}) {
  const connFace = withConnection
    ? { fetch: { register: (route) => { registered.push(route); return () => registered.pop(); } } }
    : undefined;
  return {
    slots: {
      inject: (name, cb) => cb(),
      register: (opts, comp) => () => {},
    },
    effect: (fn, hint) => { effectsRan.push(hint); fn(); },
    // cordis 注入语义：回调收到的 c 能解析注入清单里的服务键
    inject: (names, cb) => {
      const c = {
        get: (key) => (names.includes(key) && key === 'connection' ? connFace : undefined),
        effect: (fn2, hint2) => { effectsRan.push(hint2); fn2(); },
      };
      return cb(c);
    },
    get(name) { return name === 'connection' ? connFace : undefined; },
  };
}

// 面板宿主模块
const panelHost = await import('../src/panel-host.js');

// ---------- F 先证明"未 bind 数据"时是明确 not-ready ----------
{
  const ctx = makeCtx();
  const r = panelHost.mountPanelRoutes(ctx);
  check('F', 'connection 在而数据未 bind：events 返回明确 not-ready',
    r.ok === true && registered.length === 2,
    `routes=${registered.length}`);
  const evRoute = registered.find((x) => x.path === '/api/dsh-pdr/events');
  const res = await evRoute.fetch(new Request('http://x/api/dsh-pdr/events', { method: 'POST', body: '{}' }));
  const j = await res.json();
  check('F2', '未 bind 时 events 返回 dsh-pdr/not-ready（不是 undefined）',
    j.ok === false && j.error?.code === 'dsh-pdr/not-ready', JSON.stringify(j).slice(0, 120));
  // 停掉重试定时器，避免句柄泄漏（connection 存在时不会走到重试，但防御性清理）
  registered.length = 0;
}

// ---------- 真实数据装配 ----------
const api = {
  getEvents: (q) => probe.getEvents(q ?? {}),
  getRedFlags: () => probe.getRedFlags(),
  getVerdicts: () => [],
  getStats: () => ({ ...probe.getStats(), blocked: 0 }),
};
panelHost.bindFirewallApi(api);

// 制造真实事件（不同 api 类别 + 一条红线组合）
const victim = await import(pathToFileURL(path.join(HERE, 'fixtures', 'victim', 'index.mjs')).href);
probe.reset();
const marker = path.join(HERE, 'fixtures', 'victim', 'package.json');
probe.registerPlugin('panel-plg', path.join(HERE, 'fixtures', 'victim'));
try { victim.stealCredentials(marker); } catch { /* 读到就够 */ }
fetch('http://127.0.0.1:9/dsh-panel-eval', { signal: AbortSignal.timeout(120) }).catch(() => {});
await new Promise((r) => setTimeout(r, 250));

// ---------- A 路由注册形状 ----------
{
  registered.length = 0;
  const ctx = makeCtx();
  const r = panelHost.mountPanelRoutes(ctx);
  const ev = registered.find((x) => x.path === '/api/dsh-pdr/events');
  const ov = registered.find((x) => x.path === '/api/dsh-pdr/overview');
  check('A', '两条 POST 路由经 connection.fetch.register 注册，且包在 ctx.effect 里',
    r.ok === true && registered.length === 2
    && ev?.methods?.includes('POST') && ev?.requestBody === 'buffered'
    && typeof ev?.fetch === 'function'
    && effectsRan.includes('dsh-pdr-plugin: panel routes'),
    JSON.stringify(registered.map((x) => ({ p: x.path, m: x.methods }))));
}

// ---------- B events 数据（先经 runAs 造两条 panel-plg 事件，保证有可断言的数据）----------
{
  probe.reset();
  await probe.runAs('panel-plg', async () => {
    try { req('node:fs').readFileSync(marker, 'utf8'); } catch { /* 读到即记账 */ }
    await new Promise((r) => setTimeout(r, 30));
    try { req('node:fs').readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'); } catch { /* 同上 */ }
  });
  await new Promise((r) => setTimeout(r, 200));

  const ctx = makeCtx();
  panelHost.mountPanelRoutes(ctx);
  const ev = registered.find((x) => x.path === '/api/dsh-pdr/events');
  const res = await ev.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ limit: 50 }) }));
  const j = await res.json();
  const events = Array.isArray(j.value) ? j.value : [];
  const sorted = events.every((e, i, a) => i === 0 || a[i - 1].t >= e.t);
  check('B', 'events 返回倒序真实事件（含 actor/api/target）',
    j.ok === true && Array.isArray(j.value) && events.length >= 2 && sorted && events.every((e) => e.actor && e.api),
    `count=${events.length} sorted=${sorted} first=${events[0] ? JSON.stringify(events[0]).slice(0, 90) : 'none'}`);
}

// ---------- C overview 画像（事件经 probe.runAs 归因到 panel-plg）----------
{
  probe.reset();
  await probe.runAs('panel-plg', async () => {
    try { req('node:fs').readFileSync(marker, 'utf8'); } catch { /* 读到即记账 */ }
    fetch('http://127.0.0.1:9/dsh-panel-c', { signal: AbortSignal.timeout(120) }).catch(() => {});
  });
  await new Promise((r) => setTimeout(r, 250));

  const ctx = makeCtx();
  panelHost.mountPanelRoutes(ctx);
  const ov = registered.find((x) => x.path === '/api/dsh-pdr/overview');
  const res = await ov.fetch(new Request('http://x', { method: 'POST', body: '{}' }));
  const j = await res.json();
  const plg = (j.value?.plugins ?? []).find((p) => p.name === 'panel-plg');
  check('C', 'overview 返回插件画像（网络/fs/凭据分类 + 红线 + 探针健康）',
    j.ok === true && !!plg && plg.total >= 2 && plg.network >= 1
    && typeof plg.fs === 'number' && Array.isArray(plg.redLines)
    && typeof j.value.stats?.mode === 'string',
    `panel-plg=${plg ? JSON.stringify(plg).slice(0, 140) : 'ABSENT — actors: ' + (j.value?.plugins ?? []).map((p) => p.name).join(',')}`);
}

// ---------- D actor 过滤透传（value 与 B 相同，是事件数组本身）----------
{
  const ctx = makeCtx();
  panelHost.mountPanelRoutes(ctx);
  const ev = registered.find((x) => x.path === '/api/dsh-pdr/events');
  const res = await ev.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ actor: 'panel-plg' }) }));
  const j = await res.json();
  const events = Array.isArray(j.value) ? j.value : [];
  check('D', 'actor 过滤透传（只回该插件的事件）',
    j.ok === true && events.length >= 1 && events.every((e) => e.actor === 'panel-plg'),
    `count=${events.length} actors=${[...new Set(events.map((e) => e.actor))].join(',')}`);
}

// ---------- E connection 缺位 ----------
{
  const ctx = makeCtx({ withConnection: false });
  let threw = false;
  let r = null;
  try { r = panelHost.mountPanelRoutes(ctx); } catch { threw = true; }
  check('E', 'connection 缺位：ok:false + 原因，不抛错', threw === false && r.ok === false && !!r.reason, JSON.stringify(r));
}

// ---------- G/H client bundle ----------
{
  const src = readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8');
  const loaded = [];
  const factory = new Function('require', 'window', `return (${src})(require);`).bind(null, (spec) => {
    loaded.push(spec);
    if (spec === 'react') {
      return {
        createElement: (...a) => ({ $$el: a[0], props: a[1] }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: (fn) => { const d = fn(); if (typeof d === 'function') d(); },
      };
    }
    throw new Error('unexpected require: ' + spec);
  });
  const mod = factory();
  const regs = [];
  const mod2 = { name: mod.name, inject: mod.inject, apply: mod.apply };
  mod2.apply({
    slots: {
      inject: (name, cb) => cb(),
      register: (opts) => { regs.push(opts); return () => {}; },
    },
    effect: (fn) => fn(),
  });
  const view = regs.find((r) => r.name === 'conversation.view' && r.id === 'pdr-monitor');
  check('G', 'client bundle 在宿主装载形态下注册 conversation.view（id=pdr-monitor, order=30）',
    mod.name === 'dsh-pdr-plugin' && !!view && view.order === 30 && mod.inject.includes('slots'),
    `regs=${JSON.stringify(regs.map((r) => ({ id: r.id, order: r.order })))}`);
  check('H', 'client 零依赖：只 require react（宿主只保证 react/primitives）',
    loaded.every((s) => s === 'react'), `requires=${loaded.join(',')}`);
}

const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length };
console.log(JSON.stringify({ metrics, results }, null, 2));
process.exit(metrics.all ? 0 : 1);
