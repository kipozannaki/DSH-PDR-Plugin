/**
 * 宿主 web 接入冒烟：验证 host-web.js 的契约适配 + api-handlers 的路由行为
 *
 * dsh-h3/h3 是宿主 Typert 虚拟模块（离线不可解析），因此注入 runtime shim，
 * 语义对齐 dsh-tauri-pet 实测契约：
 *   defineWebServer((app) => { app.get(path, defineEventHandler(fn)) }) → (ctx) => dispose
 *   ctx.effect(() => server(ctx), name)
 * 断言：挂载结果、五个 API 端点、面板静态资源、404、live 数据源形态。
 */
import http from 'node:http';
import { report } from './_report.mjs';
import { mountFirewallWeb } from '../src/host-web.js';
import { createDataSource, createLiveSource } from '../src/client/api-handlers.mjs';

const out = { checks: {} };

// ---------- runtime shim（对齐 h3 语义） ----------
const routeTable = new Map();
const effects = [];
const runtime = {
  defineWebServer: (setup) => (ctx) => {
    const app = {
      get: (p, handler) => routeTable.set(p, handler),
      use: () => {},
    };
    setup(app);
    return () => routeTable.clear();
  },
  defineEventHandler: (fn) => fn,
  setHeader: (event, k, v) => { event._headers[k.toLowerCase()] = v; },
};

// ---------- 挂载（demo 数据源） ----------
const source = createDataSource({});
const mount = await mountFirewallWeb({
  ctx: { effect: (fn, name) => effects.push({ name, dispose: fn() }) },
  source,
  runtime,
});
out.checks['mount-ok'] = mount.ok === true && mount.mode === 'injected';
out.checks['routes-registered'] = mount.routes?.length === 8;

// ---------- 真实 HTTP 桥接 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routeTable.get(url.pathname);
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'not-found' }));
  }
  try {
    const event = { path: req.url, node: { req, res }, _headers: {} };
    const body = await handler(event);
    const headers = { 'content-type': event._headers['content-type'] ?? 'text/plain', ...event._headers };
    res.writeHead(200, headers);
    res.end(body);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error?.message ?? error));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const get = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition'), text: await res.text() };
};

// ① overview
const ov = await get('/api/firewall/overview');
const ovJson = JSON.parse(ov.text);
out.checks['overview'] = ov.status === 200
  && Array.isArray(ovJson.plugins) && ovJson.plugins.length > 0
  && typeof ovJson.plugins[0].trust?.score === 'number';

// ② events（含筛选）
const evAll = JSON.parse((await get('/api/firewall/events?limit=500')).text);
const evRl = JSON.parse((await get('/api/firewall/events?flag=redline')).text);
out.checks['events'] = evAll.events.length > 0;
out.checks['events-filter-redline'] = evRl.events.length > 0 && evRl.events.length <= evAll.events.length;

// ③ redflags
const rf = JSON.parse((await get('/api/firewall/redflags')).text);
out.checks['redflags'] = rf.redFlags.length > 0;

// ④ export
const ex = await get('/api/firewall/export');
const exJson = JSON.parse(ex.text);
out.checks['export'] = ex.disposition?.includes('attachment')
  && exJson.disclaimer?.includes('不替代人工审查')
  && Array.isArray(exJson.events);

// ⑤ 静态面板 + 资源
const panel = await get('/firewall/');
out.checks['panel-html'] = panel.status === 200 && panel.text.includes('插件安全中心');
const appJs = await get('/firewall/app.js');
out.checks['panel-assets'] = appJs.status === 200 && appJs.type.includes('javascript');

// ⑥ 404
out.checks['unknown-404'] = (await get('/api/firewall/nope')).status === 404;

// ⑦ live 数据源形态（stub api）
const stubApi = {
  getSummary: () => ({ actors: [{ actor: 'stub-plugin', total: 3, network: 1, fs: 2, subprocess: 0, credentials: 1 }], stats: { installed: true, mode: 'both', totalEvents: 3, stored: 3, dropped: 0, errors: 0 } }),
  getEvents: (q) => [{ t: Date.now(), actor: 'stub-plugin', api: 'fs.readFileSync', target: '/x/.credentials.yaml', flags: ['credentials-access'] }],
  getRedFlags: () => [{ rule: 'credentials+network', t: Date.now(), actor: 'stub-plugin', api: 'fetch', target: 'http://203.0.113.7/p' }],
};
const liveOv = createLiveSource(stubApi).getOverview();
out.checks['live-source'] = liveOv.plugins[0].verdict === 'BLOCK'
  && liveOv.plugins[0].redLines.includes('credentials+network')
  && typeof liveOv.plugins[0].trust?.score === 'number';

server.close();
out.ok = Object.values(out.checks).every(Boolean);
report(out);
