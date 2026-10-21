/**
 * DSH-PDR-Plugin · M1 集成冒烟（真实 cordis + cordis-plugin-loader）
 *
 * 验证链路：
 *  1. 时序 A 模拟：探针先于一切模块 import 安装（对应 cordis.patch.yml earlyInstall）
 *  2. loader 顺序加载 firewall → victim：victim 的红线行为被记录且归因正确
 *  3. 红线组合告警触发（credentials+network / cleartext-http）
 *  4. JSONL 落盘可解析、防火墙自观测不污染时间线
 *  5. 体检卡 v0：victim 静态扫描判 BLOCK，能力面 network/shell 提取正确
 *  6. 快照/回滚 roundtrip
 */
import path from 'node:path';
import { report } from './_report.mjs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { requireDshNodeModules } from './_deps.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

// ---------- ① 时序 A：先装探针，再碰任何其他模块 ----------
// 本测试经真实 cordis loader 加载插件，而 loader 不会对插件入口做 runAs 包裹，
// 所以归因依赖**栈兜底**。探针默认模式为 'als'（性能优先），必须显式要求 stack/both，
// 否则测到的是"默认模式选了谁"而不是"归因能力"。
const probe = req('../src/probe/probe-core.cjs');
probe.install({ mode: process.env.PDR_PROBE_MODE || 'both' });

const DEPS = requireDshNodeModules('smoke 集成冒烟');
const TMP = mkdtempSync(path.join(tmpdir(), 'fw-m1-smoke-'));
const dataDir = path.join(TMP, 'firewall-data');
const profileDir = path.join(TMP, 'fake-profile');
mkdirSync(profileDir, { recursive: true });

// 假凭据（不碰真实凭据）
const FAKE_HOME = path.join(TMP, 'fake-home', '.dsh');
mkdirSync(FAKE_HOME, { recursive: true });
const CRED = path.join(FAKE_HOME, '.credentials.yaml');
writeFileSync(CRED, 'api-key: fake\n');

const MARKER = path.join(TMP, 'marker-victim.txt');
writeFileSync(MARKER, 'x');

// 快照对象：profile 三件套
writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'fake-profile', dependencies: { victim: '1.0.0' } }, null, 2));
writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n');

// 本地回环 HTTP（明文外联不出网）
const server = http.createServer((_q, r) => r.end('ok'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const EXFIL_URL = `http://127.0.0.1:${server.address().port}/collect`;

// ---------- ② 真实 loader 装配 ----------
const out = { checks: {} };
try {
  const cordisMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis/lib/index.js')).href);
  const loaderMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href);
  const Context = cordisMod.Context;
  const Loader = loaderMod.default ?? loaderMod.Loader;

  const root = new Context();
  await root.plugin(Loader, { baseUrl: import.meta.url });

  // firewall 先加载（安装/订阅就位）
  const firewallId = await root.loader.create({
    name: '../src/index.js',
    config: {
      dataDir,
      profileDir,
      plugins: [{ name: 'victim', dir: path.join(HERE, 'fixtures', 'victim') }],
    },
  });
  await root.loader.await();
  // API 面：ctx 挂载优先，getApi() 兜底（ctx 代理形态差异）
  const fwEntry = root.loader.resolve(firewallId);
  const api = fwEntry?.fiber?.ctx?.firewall ?? root.firewall ?? (await import('../src/index.js')).getApi();
  out.checks['firewall-loaded'] = api != null;

  // victim 加载（其 apply 即触发作恶）
  const victimId = await root.loader.create({
    name: './fixtures/victim/index.mjs',
    config: { credPath: CRED, exfilUrl: EXFIL_URL, marker: MARKER },
  });
  await root.loader.await();
  await new Promise((r) => setTimeout(r, 50)); // 等 timer 场景与 fetch 入账

  // ---------- ③ 断言 ----------
  const events = api.getEvents({ limit: 500 });
  const findEv = (marker, actor) => events.find((e) => (e.target || '').includes(marker) && (!actor || e.actor === actor));
  const evCred = findEv('.credentials.yaml', 'victim');
  const evNet = findEv('/collect', 'victim');
  const evCleartext = findEv('203.0.113.7', 'victim');
  const evChild = findEv('echo pwned', 'victim');
  const evTimer = findEv('marker-victim.txt', 'victim');

  out.checks['cred-attributed'] = evCred?.actor === 'victim' && evCred?.flags.includes('credentials-access');
  out.checks['net-attributed'] = evNet?.actor === 'victim'; // 回环不算明文外联（口径对齐：本机目标不触发 cleartext）
  out.checks['cleartext-flagged'] = evCleartext?.actor === 'victim' && evCleartext?.flags.includes('cleartext-http');
  out.checks['child-attributed'] = evChild?.actor === 'victim' && evChild?.flags.includes('subprocess');
  out.checks['timer-attributed'] = evTimer?.actor === 'victim';

  const flags = api.getRedFlags().map((f) => f.rule);
  out.checks['redline-credentials-network'] = flags.includes('credentials+network');
  out.checks['redline-cleartext-http'] = flags.includes('cleartext-http');

  // JSONL 落盘
  const logPath = api.eventLogPath;
  const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  out.checks['jsonl-written'] = logLines.length > 0
    && logLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  out.checks['jsonl-has-victim'] = logLines.some((l) => l.includes('"victim"'));

  // 自观测排除
  out.checks['self-noise-excluded'] = !events.some((e) => e.actor === 'dsh-pdr-plugin');

  // 总览
  const summary = api.getSummary();
  out.checks['summary-victim'] = summary.actors.some((a) => a.actor === 'victim' && a.total > 0);

  // 体检卡 v0
  const card = api.healthCard(path.join(HERE, 'fixtures', 'victim'));
  out.healthCard = { verdict: card.verdict, capabilities: card.capabilities?.map((c) => c.id), redLines: card.redLines?.map((r) => r.rule) };
  out.checks['healthcard-block'] = card.verdict === 'BLOCK';
  out.checks['healthcard-caps'] = ['network', 'shell'].every((c) => card.capabilities.some((x) => x.id === c));

  // 快照/回滚 roundtrip
  const snap = api.snapshotProfile(profileDir, 'smoke');
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'mutated' }));
  const restored = api.restoreSnapshot(snap.id, { profileDir });
  const restoredPkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  out.checks['snapshot-roundtrip'] = restored.ok && restoredPkg.name === 'fake-profile';

  out.probeStats = api.getStats();
  out.ok = Object.values(out.checks).every(Boolean);
  await root.loader.remove(victimId);
  await root.loader.remove(firewallId);
} catch (error) {
  out.ok = false;
  out.error = String(error?.stack ?? error).split('\n').slice(0, 8).join('\n');
} finally {
  server.close();
}

report(out);
