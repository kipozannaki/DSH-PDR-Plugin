/**
 * 宿主半边 · 面板数据通道（connection.fetch 接缝）
 *
 * 契约来源：dsh-context v0.77.0 的 src/host/connection.ts（真实运行中的社区插件，
 * 与本插件同宿主验证）。每个插件的 fetch 路由都是同一个 `/api` 围栏下的 POST：
 *
 *   ctx.inject(['connection'], (c) => {
 *     const register = c.get('connection')?.fetch?.register;
 *     register({ path, methods: ['POST'], requestBody: 'buffered', fetch: (request) => Response })
 *   })
 *
 * 真机教训（web 宿主 rc.4 实证，逐条排出来的）：
 *   ① inject 清单里混入不存在的键（client-connection 是包名不是服务名）→
 *      回调终身不触发、路由 404。清单只声明确实存在的服务。
 *   ② 本插件 fiber 可能先于 connection 服务激活（deferred inject 在部分版本不补偿），
 *      所以挂载是**重试式**的：立即试，失败就定时重试，服务出现即挂。
 *   ③ 失败绝不影响防火墙主功能——client 面板会显示"数据通道未接入"。
 */

/** 探针单例引用（index.js 装配时注入，避免二次 require 造成双实例） */
let apiRef = null;

/** @param {object} api index.js 组装好的防火墙 API 面 */
export function bindFirewallApi(api) {
  apiRef = api;
}

/** 统一 JSON 应答（与宿主其它数据路由一致的 no-store 约定） */
function reply(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function failure(code, message) {
  return reply({ ok: false, error: { code, message } });
}

export const EVENTS_ROUTE = '/api/dsh-pdr/events';
export const OVERVIEW_ROUTE = '/api/dsh-pdr/overview';

/** events 路由：query 从 POST body JSON 里取（actor/flag/q/limit，与 api-handlers 同语义）。
 * 结果按 t 倒序返回（面板直接渲染时间线），这是本路由的契约，不在客户端重复排序。 */
function handleEvents(body) {
  const api = apiRef;
  if (!api) return failure('dsh-pdr/not-ready', 'firewall api not assembled yet');
  const q = body ?? {};
  const events = api.getEvents({
    actor: typeof q.actor === 'string' && q.actor ? q.actor : undefined,
    flag: typeof q.flag === 'string' && q.flag ? q.flag : undefined,
    q: typeof q.q === 'string' ? q.q : undefined,
    limit: Number.isFinite(q.limit) ? q.limit : 200,
  });
  events.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return reply({ ok: true, value: events });
}

/** overview 路由：插件画像 + 红线 + 判定 + 探针健康（面板首屏） */
function handleOverview() {
  const api = apiRef;
  if (!api) return failure('dsh-pdr/not-ready', 'firewall api not assembled yet');
  const redFlags = api.getRedFlags();
  const verdicts = typeof api.getVerdicts === 'function' ? api.getVerdicts() : [];
  const stats = api.getStats();
  const rulesByActor = new Map();
  for (const f of redFlags) {
    const list = rulesByActor.get(f.actor) ?? [];
    if (!list.includes(f.rule)) list.push(f.rule);
    rulesByActor.set(f.actor, list);
  }
  const byActor = new Map();
  for (const e of api.getEvents({ limit: 2000 })) {
    const row = byActor.get(e.actor) || {
      name: e.actor, total: 0, network: 0, fs: 0, subprocess: 0, credentials: 0, lastAt: 0,
    };
    row.total++;
    if (/^https?:|^fetch|^net\.|^(http|https)\./.test(e.api)) row.network++;
    else if (e.api.startsWith('child_process')) row.subprocess++;
    else row.fs++;
    if (e.flags?.includes('credentials-access')) row.credentials++;
    if ((e.t ?? 0) > row.lastAt) row.lastAt = e.t;
    byActor.set(e.actor, row);
  }
  const plugins = [...byActor.values()].map((row) => {
    const redLines = rulesByActor.get(row.name) ?? [];
    const v = verdicts.find((x) => x.actor === row.name);
    return {
      ...row,
      redLines,
      judge: v ? { verdict: v.verdict, zh: v.zh, severity: v.severity } : null,
    };
  }).sort((a, b) => b.total - a.total);
  return reply({
    ok: true,
    value: {
      generatedAt: Date.now(),
      stats: {
        mode: stats.mode, totalEvents: stats.totalEvents, blocked: stats.blocked ?? 0,
        dropped: stats.dropped ?? 0, errors: stats.errors ?? 0,
        registryHooked: stats.registryHooked ?? false, hookOrder: stats.hookOrder ?? -1,
      },
      plugins,
      redFlagCount: redFlags.length,
    },
  });
}

/** 在当前 ctx 上找 fetch.register（双键探测；都没有返回 null） */
function findRegistrar(ctx) {
  for (const key of ['connection', 'client-connection']) {
    try {
      const c = ctx?.get?.(key);
      const r = c && c.fetch && c.fetch.register;
      if (typeof r === 'function') return r.bind(c.fetch);
    } catch { /* 形态不符试下一个键 */ }
  }
  return null;
}

/** 立即挂载（成功返回 true）。注册包在 ctx.effect 里，随 fiber 卸载自动撤销。 */
function mountNow(ctx) {
  const register = findRegistrar(ctx);
  if (!register) return false;
  ctx.effect(() => {
    const disposers = [];
    disposers.push(register({ path: EVENTS_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
      let body = {};
      try { body = await request.json(); } catch { /* 空 body 合法 */ }
      return handleEvents(body);
    } }));
    disposers.push(register({ path: OVERVIEW_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: async () => handleOverview() }));
    return () => { for (const d of disposers) { try { d(); } catch { /* 尽力撤销 */ } } };
  }, 'dsh-pdr-plugin: panel routes');
  return true;
}

/**
 * 注册面板数据路由（重试式）。返回 { ok, routes, reason? }。
 *
 * 为什么重试：本插件 fiber 可能先于 connection 服务激活；cordis 的 deferred inject
 * 在该宿主版本不补偿这种时序（真机实证：回调终身不触发）。2 秒一次、最多 30 次
 * （一分钟），服务出现即挂；期间面板显示"数据通道未接入"。
 */
export function mountPanelRoutes(ctx) {
  if (mountNow(ctx)) return { ok: true, routes: [EVENTS_ROUTE, OVERVIEW_ROUTE] };

  let tries = 0;
  const timer = setInterval(() => {
    if (mountNow(ctx)) {
      clearInterval(timer);
      return;
    }
    if (++tries >= 30) clearInterval(timer);
  }, 2000);
  // fiber 卸载时停掉重试，不让定时器挂到进程尾
  try { ctx.effect(() => () => clearInterval(timer), 'dsh-pdr-plugin: panel retry'); } catch { /* 尽力 */ }
  return { ok: false, routes: [], reason: 'connection not ready; deferred mount retrying' };
}
