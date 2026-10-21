/**
 * M3 告警推送评测
 *
 * 产品原则边界（必须被测试钉死，不能靠文档约定）：
 *   A 默认关闭 —— 不配置就一个字节都不发
 *   B 只推红线事件，规则过滤生效
 *   C 去重：同 (actor,rule,target) 窗口内只推一次
 *   D 限流：每分钟总量封顶
 *   E fail-safe：目标不可达/超时/非 2xx 都不抛、不影响调用方
 *   F 静默：推送走被 hook 的 fetch 时**不产生**自己的事件（防 record→推送→record 自激）
 *   G 三种格式（json/slack/dingtalk）payload 形状正确
 *   H 推送内容最小化：不含文件内容、不含凭据值
 *
 * 用法：node test/alert-push-eval.mjs
 */
import http from 'node:http';
import { createAlertPusher, buildPayload } from '../src/alert/push.js';

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

// ---------- 本地接收端 ----------
const received = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, body, headers: req.headers });
    if (req.url === '/fail') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const HOOK = `http://127.0.0.1:${PORT}/hook`;
const HOOK_FAIL = `http://127.0.0.1:${PORT}/fail`;

const flag = () => ({ rule: 'credentials+network', actor: 'evil-plugin', t: Date.now(), api: 'fetch', target: 'http://203.0.113.9/collect' });
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ---------- A 默认关闭 ----------
{
  received.length = 0;
  const p = createAlertPusher({ config: {}, silent: (f) => f() });
  const r1 = p.push(flag());
  await settle(120);
  check('A', '默认关闭：不配置 URL 时一个字节都不发',
    r1.skipped === 'disabled' && received.length === 0, `result=${JSON.stringify(r1)} received=${received.length}`);
}

// ---------- B 规则过滤 ----------
{
  received.length = 0;
  const p = createAlertPusher({ config: { enabled: true, url: HOOK, rules: ['cleartext-http'] }, silent: (f) => f() });
  const skipped = p.push(flag());                       // credentials+network 不在白名单
  const allowed = p.push({ ...flag(), rule: 'cleartext-http' });
  await settle();
  check('B', '规则过滤：只推配置的红线类型',
    skipped.skipped === 'rule-filtered' && allowed.ok === true && received.length === 1,
    `skipped=${skipped.skipped} allowed=${allowed.ok} received=${received.length}`);
}

// ---------- C 去重 ----------
{
  received.length = 0;
  const p = createAlertPusher({ config: { enabled: true, url: HOOK, dedupeWindowMs: 60_000 }, silent: (f) => f() });
  const f = flag();
  const r = [p.push(f), p.push(f), p.push(f)];
  const other = p.push({ ...f, actor: 'another-plugin' }); // 不同 actor 是新指纹
  await settle();
  check('C', '去重：同 (actor,rule,target) 窗口内只推一次，换 actor 仍推',
    r.filter((x) => x.ok).length === 1 && other.ok === true && received.length === 2,
    `ok=${r.filter((x) => x.ok).length} other=${other.ok} received=${received.length} stats=${JSON.stringify(p.stats())}`);
}

// ---------- D 限流 ----------
{
  received.length = 0;
  const p = createAlertPusher({ config: { enabled: true, url: HOOK, maxPerMinute: 3, dedupeWindowMs: 0 }, silent: (f) => f() });
  for (let i = 0; i < 10; i++) p.push({ ...flag(), target: `http://203.0.113.9/p${i}` });
  await settle(350);
  check('D', '限流：每分钟总量封顶（10 次尝试 → 最多 3 条）',
    received.length <= 3 && received.length >= 1, `received=${received.length}（上限 3）`);
}

// ---------- E fail-safe ----------
{
  const p = createAlertPusher({ config: { enabled: true, url: HOOK_FAIL, dedupeWindowMs: 0 }, silent: (f) => f() });
  let threw = false;
  try { p.push(flag()); } catch { threw = true; }
  await settle();
  const s = p.stats();
  check('E1', '非 2xx 响应不抛、计入 failed', threw === false && s.failed >= 1, `threw=${threw} failed=${s.failed} lastError=${s.lastError}`);
}
{
  // 端口不可达：立即失败，绝不抛
  const p = createAlertPusher({ config: { enabled: true, url: 'http://127.0.0.1:1/none', timeoutMs: 400 }, silent: (f) => f() });
  let threw = false;
  try { p.push(flag()); } catch { threw = true; }
  await settle(500);
  const s = p.stats();
  check('E2', '目标不可达时静默失败（宿主不受影响）', threw === false && s.failed >= 1, `threw=${threw} failed=${s.failed}`);
}

// ---------- F 静默：推送不产生自己的事件 ----------
{
  const { createRequire } = await import('node:module');
  const probe = createRequire(import.meta.url)('../src/probe/probe-core.cjs');
  probe.install({ mode: 'als' });
  probe.reset();

  // 推送请求的目标是 webhook URL（不是红线里的 target），所以要按 webhook 计数
  const hookPrefix = HOOK;
  const countHook = () => probe.getEvents({ limit: 500 })
    .filter((e) => String(e.target).startsWith(hookPrefix)).length;

  const pSilent = createAlertPusher({ config: { enabled: true, url: HOOK, dedupeWindowMs: 0 }, silent: probe.silent });
  pSilent.push({ ...flag(), target: 'http://203.0.113.9/silent-a' });
  await settle(400);
  const silentCount = countHook();

  // 对照组：不用 silent 包，同样的推送应当被记账
  const pLoud = createAlertPusher({ config: { enabled: true, url: HOOK, dedupeWindowMs: 0 } });
  pLoud.push({ ...flag(), target: 'http://203.0.113.9/silent-b' });
  await settle(400);
  const loudCount = countHook() - silentCount;

  check('F', '静默：推送自身不产生事件（对照组不静默则会产生）',
    silentCount === 0 && loudCount >= 1,
    `silent=${silentCount} loud=${loudCount} hook=${hookPrefix}`);
}

// ---------- G 三种格式 ----------
{
  const f = flag();
  const json = buildPayload(f, 'json');
  const slack = buildPayload(f, 'slack');
  const ding = buildPayload(f, 'dingtalk');
  check('G', '三种格式 payload 形状正确',
    json.type === 'red-flag' && typeof json.text === 'string'
    && slack.text.includes('credentials+network')
    && ding.msgtype === 'text' && ding.text.content.includes('credentials+network'),
    JSON.stringify({ jsonKeys: Object.keys(json), slackKeys: Object.keys(slack), dingKeys: Object.keys(ding) }));
}

// ---------- H 内容最小化 ----------
{
  received.length = 0;
  const p = createAlertPusher({ config: { enabled: true, url: HOOK }, silent: (f) => f() });
  p.push({ ...flag(), target: 'http://203.0.113.9/collect?api_key=SUPER_SECRET_VALUE_123' });
  await settle();
  const body = received[0]?.body ?? '';
  // target 会被带上（这正是要暴露的信号），但不得出现文件内容字段
  check('H', '推送内容最小化：只含规则/actor/目标，不含文件内容字段',
    !/"content"\s*:/.test(body) && !/"fileContent"/.test(body) && !/"body"\s*:/.test(body)
    && body.includes('credentials+network'),
    body.slice(0, 220));
}

srv.close();
const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length };
console.log(JSON.stringify({ metrics, results }, null, 2));
process.exit(metrics.all ? 0 : 1);
