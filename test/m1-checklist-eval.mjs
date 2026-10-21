/**
 * 第 1 项 · 测试 profile 实装，收 M1 检查单
 *
 * 关键未验项（README「真实宿主验证清单」第 1 条）：
 *   earlyInstall 的 `!!js` 表达式是否真的先于其他插件 import 执行。
 * 本测试用**真实机器**（dsh-app-boot 的 loadOverlayPatches 解析 + loader 的 evaluate 求值）
 * 在隔离测试 profile 里实证，而非 fixture 模拟。
 *
 * 检查：
 *  ① `!!js` 被真实 loadOverlayPatches 解析成 __jsExpr（patch 格式正确）
 *  ② 真实 evaluate 跑 earlyInstall 表达式 → 装上探针（表达式可用）
 *  ③ 时序：探针装好后，真实 loader 加载的 victim 插件行为被正确归因（探针早于插件生效）
 *  ④ 时间线落盘 + web 挂载尝试（M1 检查单 4 部分）
 *
 * 用法：node test/m1-checklist-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import { requireDshNodeModules } from './_deps.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const DEPS = requireDshNodeModules('m1-checklist');

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-m1-'));
const PROFILE = path.join(TMP, 'profile');

// 测试 profile：node_modules/dsh-pdr-plugin → 真插件（junction，Windows 免管理员）
mkdirSync(path.join(PROFILE, 'node_modules'), { recursive: true });
symlinkSync(PLUGIN_DIR, path.join(PROFILE, 'node_modules', 'dsh-pdr-plugin'), 'junction');

// victim 插件：装进 profile 的 node_modules，做红线行为
const VICTIM = path.join(PROFILE, 'node_modules', 'victim-plg');
mkdirSync(VICTIM, { recursive: true });
writeFileSync(path.join(VICTIM, 'package.json'), JSON.stringify({ name: 'victim-plg', version: '1.0.0', type: 'module', main: 'index.mjs' }));
writeFileSync(path.join(VICTIM, 'index.mjs'), `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
export default function (ctx, config) {
  try { fs.readFileSync(CRED, 'utf8'); } catch {}
  fetch('http://203.0.113.7/p', { signal: AbortSignal.timeout(500) }).catch(() => {});
  return {};
}
`);

// 本测试经真实 cordis loader 加载 victim，loader 不对插件入口做 runAs 包裹，
// 归因依赖栈兜底。探针默认模式已是 'als'（性能优先，见 research/M0开销终审-v0.md），
// 故这里显式指定 stack——测的是"earlyInstall 时序 + 归因能力"，不是默认模式选谁。
process.env.PDR_PROBE_MODE = process.env.PDR_PROBE_MODE || 'stack';

const probe = req('../src/probe/probe-core.cjs');

try {
  // ---------- ① 真实 loadOverlayPatches 解析 !!js ----------
  const { loadOverlayPatches } = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const loaderMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href);
  const { isJsExpr, evaluate } = loaderMod;

  const patches = loadOverlayPatches('dsh', path.join(PLUGIN_DIR, 'cordis.patch.yml'));
  const fwEntry = patches.flatMap((p) => p.insert ?? []).find((e) => e.id === 'dsh-pdr-plugin');
  const earlyExpr = fwEntry?.config?.earlyInstall;
  check('A', '① !!js 被真实 loadOverlayPatches 解析成 __jsExpr', isJsExpr(earlyExpr) === true, JSON.stringify(earlyExpr)?.slice(0, 80));

  // ---------- ② 真实 evaluate 跑 earlyInstall 表达式 ----------
  const before = probe.isInstalled();
  const baseUrl = pathToFileURL(path.join(PROFILE, 'boot.js')).href; // 真实 host 的 baseUrl 形态（profile 内模块 URL）
  const evalResult = evaluate({ baseUrl }, earlyExpr.__jsExpr);
  check('B', '② 真实 evaluate 执行 earlyInstall → 装上探针', evalResult === true && probe.isInstalled() === true && !before, JSON.stringify({ before, evalResult, after: probe.isInstalled() }));

  // ---------- ③ 时序：探针早于 victim 生效，行为归因正确 ----------
  const Context = (await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis/lib/index.js')).href)).Context;
  const Loader = loaderMod.default ?? loaderMod.Loader;
  const dataDir = path.join(TMP, 'firewall-data');

  const root = new Context();
  await root.plugin(Loader, { baseUrl: pathToFileURL(path.join(PROFILE, 'boot.js')).href });

  // firewall 条目（其 config 携带 __jsExpr，loader 会 interpolate 求值——走真实路径）
  const fwId = await root.loader.create({
    name: pathToFileURL(path.join(PLUGIN_DIR, 'src', 'index.js')).href,
    config: { dataDir, plugins: [{ name: 'victim-plg', dir: VICTIM }] },
  });
  await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 3000))]);
  const api = root.loader.resolve(fwId)?.fiber?.ctx?.firewall ?? (await import('../src/index.js')).getApi();

  probe.reset();
  const vicId = await root.loader.create({ name: './node_modules/victim-plg/index.mjs', config: {} });
  await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 3000))]);
  await new Promise((r) => setTimeout(r, 80));

  const events = api.getEvents({ limit: 200 });
  const victimEvents = events.filter((e) => e.actor === 'victim-plg');
  const hasCred = victimEvents.some((e) => e.flags?.includes('credentials-access'));
  const hasNet = victimEvents.some((e) => /^fetch|^https?:/.test(e.api));
  check('C', '③ 时序正确：victim 行为被归因到 victim-plg（探针早于插件）', victimEvents.length > 0 && hasCred && hasNet, JSON.stringify({ count: victimEvents.length, hasCred, hasNet }));

  // ---------- ④ 时间线落盘 + web 挂载尝试 ----------
  const logExists = existsSync(api.eventLogPath) && readFileSync(api.eventLogPath, 'utf8').trim().length > 0;
  const webMode = api.webMount?.mode;
  check('D', '④ 时间线落盘 + web 挂载尝试', logExists && webMode !== undefined, JSON.stringify({ logExists, webMode }));

  try { root.loader.remove(vicId); } catch { /* 清理尽力 */ }
  try { root.loader.remove(fwId); } catch { /* 清理尽力 */ }
} catch (error) {
  check('X', '测试异常', false, String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'));
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

// M1 检查单映射
const checklist = {
  '① earlyInstall !!js 求值时机': results.find((r) => r.id === 'A')?.pass && results.find((r) => r.id === 'B')?.pass && results.find((r) => r.id === 'C')?.pass,
  '④ loader 边界 + 时间线 + web（部分）': results.find((r) => r.id === 'C')?.pass && results.find((r) => r.id === 'D')?.pass,
};
const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length, checklist };
report({ metrics, results });
