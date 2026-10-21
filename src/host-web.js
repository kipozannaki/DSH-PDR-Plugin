/**
 * 宿主 web 服务接入（dsh-h3 接缝）
 *
 * 契约实测来源：dsh-tauri-pet 的 dist（真实运行中的社区插件）：
 *   const server = defineWebServer((app) => {
 *     app.use(middleware);
 *     app.get("/api/tauri/pet/session/stream", defineEventHandler(async (event) => …));
 *   });
 *   apply(ctx) { ctx.effect(() => server(ctx), "dsh-tauri-pet: routes"); }
 * 服务依赖经插件导出的 inject 声明（其含 "webServer"）。
 *
 * 现实约束（诚实记录）：dsh-h3 / h3 是宿主 Typert 虚拟模块（磁盘无实体，
 * 由宿主运行时注册表提供），离线环境 import 不到。因此本适配器：
 *   - 生产：try 动态 import('dsh-h3') + import('h3')，成功即按上述契约挂载；
 *   - 测试：接受注入 runtime（{ defineWebServer, defineEventHandler, setHeader }）验证行为；
 *   - 缺位/失败：fail-safe 返回 unavailable，绝不影响防火墙主功能（面板走独立 serve.js）。
 */
import { createRoutes } from './client/api-handlers.mjs';

async function loadRuntime() {
  try {
    const serverMod = await import('dsh-h3');
    const h3 = await import('h3');
    return {
      defineWebServer: serverMod.defineWebServer,
      defineEventHandler: h3.defineEventHandler,
      setHeader: h3.setHeader ?? ((event, k, v) => event.node?.res?.setHeader?.(k, v)),
    };
  } catch {
    return null;
  }
}

/**
 * 挂载防火墙路由。返回 { ok, mode, dispose?, error? }。
 * mode: 'dsh-h3' | 'injected' | 'unavailable'
 */
export async function mountFirewallWeb({ ctx, source, runtime = null, effectName = 'dsh-pdr-plugin: routes' } = {}) {
  const rt = runtime ?? await loadRuntime();
  if (!rt) return { ok: false, mode: 'unavailable', reason: 'dsh-h3 not resolvable（离线环境预期）' };

  const routes = createRoutes({ source });
  const server = rt.defineWebServer((app) => {
    for (const route of routes) {
      app.get(route.path, rt.defineEventHandler(async (event) => {
        const rawUrl = event.node?.req?.url ?? event.path ?? '/';
        const query = new URL(rawUrl, 'http://localhost').searchParams;
        const res = await route.handle(query);
        for (const [k, v] of Object.entries(res.headers ?? {})) rt.setHeader(event, k, v);
        rt.setHeader(event, 'content-type', res.type);
        return res.body;
      }));
    }
  });

  try {
    if (ctx && typeof ctx.effect === 'function') {
      // 宿主内标准挂载：effect 管理生命周期（fiber 卸载时自动撤销路由）
      ctx.effect(() => server(ctx), effectName);
      return { ok: true, mode: runtime ? 'injected' : 'dsh-h3', routes: routes.map((r) => r.path) };
    }
    const dispose = server(ctx);
    return { ok: true, mode: runtime ? 'injected' : 'dsh-h3', routes: routes.map((r) => r.path), dispose };
  } catch (error) {
    return { ok: false, mode: 'error', error: String(error?.message ?? error) };
  }
}
