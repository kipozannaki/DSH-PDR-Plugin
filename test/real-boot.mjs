/**
 * 运行时行为回归 v0：真实插件 × 真实 loader × 防火墙并跑
 *
 * 验证两件事：
 *  A. 静态消费普查：真实打包代码怎么消费内建模块（default / 具名 / require / fetch）
 *     —— 对照覆盖面矩阵，推算每类插件的可观测比例
 *  B. 运行时：真实插件经真实 loader 加载（import + 启动）时，
 *     其 I/O 行为是否被探针记录并正确归因（真实 bundle 帧，非 fixture）
 *
 * 注意：真实插件依赖宿主服务（inject），剥离宿主后可能挂起/报错——
 * 这本身是预期现象（记为 startOk=false / pending），import 期行为照样可观测。
 *
 * 用法：node test/real-boot.mjs [插件名 ...]  （缺省 4 个代表插件）
 */
import path from 'node:path';
import { report, skip } from './_report.mjs';
import { requireDshNodeModules, listProfiles } from './_deps.mjs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);
// ★ 时序 A：fs 不走静态 import（避免 facade 早于探针创建，实验失真）
const { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } = req('node:fs');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 开源前这里写死了作者本机的 tauri profile；别人机器上没装这些插件 → 明确跳过
const DEPS = requireDshNodeModules('real-boot');
const DEFAULT_TARGETS = ['dsh-rewind-plugin', 'dsh-context', 'dsh-connect-trae', 'dshmarket'];

/** 挑一个真的装了候选插件的 profile */
function pickProfile() {
  if (process.env.REAL_BOOT_PROFILE) return process.env.REAL_BOOT_PROFILE;
  let best = null;
  for (const p of listProfiles()) {
    const nm = path.join(p, 'node_modules');
    const hit = DEFAULT_TARGETS.filter((n) => existsSync(path.join(nm, n))).length;
    if (hit > 0 && (!best || hit > best.hit)) best = { profile: p, hit };
  }
  return best ? best.profile : null;
}

const PROFILE = pickProfile();
if (!PROFILE) {
  skip(
    `本机没有任何 profile 装有 ${DEFAULT_TARGETS.join(' / ')} 中的任一个（本用例用真实社区插件跑真实 loader）`,
    `dsh plugin --profile <某个 profile> add <上面任一插件>；或设 REAL_BOOT_PROFILE 指向已装这些插件的 profile`,
  );
} else {
  await run();
}

async function run() {
const TARGETS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS)
  .filter((n) => existsSync(path.join(PROFILE, 'node_modules', n)));
if (!TARGETS.length) {
  skip(`profile ${PROFILE} 里没有候选插件`, null);
  return;
}

// ---------- ① 静态消费普查 ----------
const CONSUMPTION = {
  namedImport: /import\s*\{[^}]*\}\s*from\s*["']node:(fs|fs\/promises|child_process|http|https|net)["']/,
  defaultImport: /import\s+[A-Za-z_$][\w$]*\s+from\s*["']node:(fs|fs\/promises|child_process|http|https|net)["']/,
  requireCall: /require\(\s*["']node:(fs|fs\/promises|child_process|http|https|net)["']\s*\)/,
  fetchGlobal: /\bfetch\s*\(/,
  httpApi: /https?\.(request|get)\b/,
  netApi: /\bnet\.connect\b|createConnection\s*\(/,
  childApi: /child_process|execSync|spawnSync|\bspawn\s*\(/,
};

function census(pluginDir) {
  const hits = {};
  let files = 0;
  for (const sub of ['dist', 'lib', 'src', '.']) {
    const dir = path.join(pluginDir, sub);
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length && files < 40) {
      const d = stack.pop();
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
        let text = '';
        try { text = readFileSync(full, 'utf8'); } catch { continue; }
        files++;
        for (const [k, re] of Object.entries(CONSUMPTION)) if (re.test(text)) hits[k] = (hits[k] || 0) + 1;
      }
    }
    break; // 只扫第一个存在的目录（与体检卡同策略）
  }
  return { files, patterns: hits };
}

function entryFileOf(pluginDir) {
  const m = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const exp = m.exports && (typeof m.exports['.'] === 'string' ? m.exports['.'] : m.exports['.']?.default);
  return String(exp || m.main || 'index.js').replace(/^\.\//, '');
}

// ---------- ② 运行时加载 ----------
const probe = req('../src/probe/probe-core.cjs');
probe.install(); // 时序 A：先于 cordis/插件 import

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-realboot-'));
const out = { profile: PROFILE, results: [] };

try {
  const cordisMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis/lib/index.js')).href);
  const loaderMod = await import(pathToFileURL(path.join(DEPS, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href);
  const Context = cordisMod.Context;
  const Loader = loaderMod.default ?? loaderMod.Loader;

  const root = new Context();
  const baseUrl = pathToFileURL(PROFILE + path.sep).href;
  await root.plugin(Loader, { baseUrl });

  // 防火墙先就位（探针 + 记录管道），插件映射显式注册（realpath 归一交给 probe）
  const firewallId = await root.loader.create({
    name: pathToFileURL(path.join(HERE, '..', 'src', 'index.js')).href,
    config: {
      dataDir: path.join(TMP, 'firewall-data'),
      plugins: TARGETS.map((n) => ({ name: n, dir: path.join(PROFILE, 'node_modules', n) })),
    },
  });
  await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 3000))]);
  const api = root.loader.resolve(firewallId)?.fiber?.ctx?.firewall ?? (await import('../src/index.js')).getApi();

  for (const name of TARGETS) {
    const dir = path.join(PROFILE, 'node_modules', name);
    const row = { name, census: census(dir) };
    try {
      row.entryFile = entryFileOf(dir);
      const rel = './node_modules/' + name + '/' + row.entryFile;
      const before = probe.getStats().totalEvents;
      probe.reset();
      const id = await root.loader.create({ name: rel, config: {} });
      await Promise.race([root.loader.await(), new Promise((r) => setTimeout(r, 4000))]);
      const entry = root.loader.resolve(id);
      row.importOk = entry?.moduleNamespace != null || entry?.fiber != null;
      row.startOk = entry?.fiber != null && entry.fiber.uid != null;
      const events = probe.getEvents({ limit: 500 });
      row.events = events.length;
      row.eventApis = [...new Set(events.map((e) => e.api))];
      row.sampleEvents = events.slice(0, 5).map((e) => ({ actor: e.actor, api: e.api, target: String(e.target).slice(0, 80) }));
      row.allAttributed = events.length === 0 || events.every((e) => e.actor === name || e.actor === 'host');
      try { await Promise.race([root.loader.remove(id), new Promise((r) => setTimeout(r, 1500))]); } catch { /* 清理尽力 */ }
    } catch (error) {
      row.importOk = false;
      row.error = String(error?.message ?? error).slice(0, 200);
    }
    out.results.push(row);
  }

  out.probeStats = api ? api.getStats() : null;
} catch (error) {
  out.fatal = String(error?.stack ?? error).split('\n').slice(0, 6).join('\n');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

/**
 * 判定口径（重要）：
 * `importOk=false` 是**预期现象**——真实插件 inject 宿主服务，剥离家主后挂起/报错，
 * 本用例要看的是"import 期的 I/O 照样可观测且归因不串"。
 * 所以判据是：每个插件都真的被观测到（events>0）且归因只落在它自己或 host 上。
 */
out.ok = out.results.length > 0
  && out.results.every((r) => r.events > 0 && r.allAttributed === true);
out.note = 'importOk=false 属预期（插件 inject 宿主服务，剥离家主后挂起/报错）；判据是"import 期 I/O 可观测且归因不串"';

report(out);
} // end run()
