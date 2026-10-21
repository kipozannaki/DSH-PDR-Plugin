/**
 * 隔离试装 · 子进程运行器（在一次性隔离环境里试启动插件）
 *
 * 被 trial.js 以子进程方式拉起 —— 隔离的意义：
 *   - 插件崩溃 / 死循环 / 进程退出，都关在本进程内，不碰真宿主
 *   - DSH_HOME 指向临时目录，插件写不进真实 home
 * 试启动走真实 cordis + cordis-plugin-loader（与 real-boot 同路线）。
 *
 * 入参：argv[2] = 插件目录
 * 出参：stdout 一行 JSON（importOk / startOk / error / behaviors / redFlags）
 */
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS = 'C:/Users/na\'k\'i/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules';

const pluginDir = path.resolve(process.argv[2] || '');
const out = { importOk: false, startOk: false, error: null, behaviors: [], redFlags: [], isoHome: null };

// 一次性隔离 DSH_HOME：插件写不进真实 home
const isoHome = mkdtempSync(path.join(tmpdir(), 'fw-trial-home-'));
process.env.DSH_HOME = isoHome;
out.isoHome = path.basename(isoHome);

let probe;
try {
  // 探针：观察试装期行为（时序 A）
  probe = req('../probe/probe-core.cjs');
  probe.install();

  const name = path.basename(pluginDir);
  probe.registerPlugin(name, pluginDir);

  const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const exp = typeof manifest.exports?.['.'] === 'string'
    ? manifest.exports['.']
    : manifest.exports?.['.']?.default;
  const entryFile = String(exp || manifest.main || 'index.js').replace(/^\.\//, '');

  // 真实 loader 试启动
  const Context = (await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis/lib/index.js')).href)).Context;
  const loaderMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href);
  const Loader = loaderMod.default ?? loaderMod.Loader;

  const root = new Context();
  await root.plugin(Loader, { baseUrl: pathToFileURL(pluginDir + path.sep).href });

  const id = await root.loader.create({ name: './' + entryFile, config: {} });
  await Promise.race([
    root.loader.await(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  const entry = root.loader.resolve(id);
  out.importOk = entry?.moduleNamespace != null || entry?.fiber != null;
  out.startOk = entry?.fiber != null && entry.fiber.uid != null;

  await new Promise((r) => setTimeout(r, 80)); // 等延迟行为
  out.behaviors = probe.getEvents({ limit: 100 }).map((e) => ({ actor: e.actor, api: e.api, target: String(e.target).slice(0, 80) }));
  out.redFlags = [...new Set(probe.getRedFlags().map((f) => f.rule))];
} catch (error) {
  out.error = String(error?.message ?? error).slice(0, 300);
} finally {
  try { rmSync(isoHome, { recursive: true, force: true }); } catch { /* 清理尽力 */ }
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
