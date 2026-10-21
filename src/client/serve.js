/**
 * 安全中心本地预览桥（宿主外独立运行）
 *
 * 与宿主挂载（src/host-web.js）共用 src/client/api-handlers.mjs 的同一份路由契约，
 * 保证预览行为 = 宿主内行为。
 *
 * 用法：
 *   node serve.js [--port 3123]                    # 演示数据
 *   node serve.js --jsonl <events.jsonl>           # 回放真实探针日志
 *   node serve.js --dataDir <firewall 数据目录>      # 回放 $DSH_HOME/firewall
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDataSource, createRoutes } from './api-handlers.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(getArg('port') || 3123);
const JSONL = getArg('jsonl') || (getArg('dataDir') ? path.join(getArg('dataDir'), 'events.jsonl') : null);

const source = createDataSource({ jsonlPath: JSONL && existsSync(JSONL) ? JSONL : null });
const routes = createRoutes({ source });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = routes.find((r) => r.path === url.pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'not-found', hint: '面板入口 /firewall/' }));
    }
    const out = await route.handle(url.searchParams);
    // 预览便利：允许页内跨源读取（仅绑定 127.0.0.1，无安全影响）
    res.writeHead(out.status, {
      'content-type': out.type,
      'access-control-allow-origin': '*',
      ...(out.headers ?? {}),
    });
    res.end(out.body);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[DSH-PDR-Plugin] 安全中心预览: http://127.0.0.1:${PORT}/firewall/  数据源: ${JSONL || '演示数据'}`);
});
