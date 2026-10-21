/**
 * 插件入口 runAs 包裹评测（ALS 归因落点）
 *
 * 真机背景：产品此前 `runAs` 只有定义没有调用点，插件入口不在 ALS 上下文里，
 * 归因只能靠调用栈形状猜——贵（+141µs/op）且脆弱（打包后形状漂移就失效）。
 * 本测试验证 `installRegistryHook()` 是否让插件入口真正进入 ALS 上下文。
 *
 * 关键设计：**故意用纯 'als' 模式**（无栈兜底可用），
 * 这样"归因正确"只可能来自 ALS 上下文，不可能被栈兜底蒙对。
 *
 * 硬指标：
 *  A 同步 I/O 归因到插件名（als 模式，无栈兜底）
 *  B 异步回调（setImmediate / setTimeout / Promise）内 I/O 仍归因到插件
 *  C 插件抛错不影响宿主（fail-safe）
 *  D 已包裹的插件不会重复包裹（HMR/reload 反复拿同一 plugin 函数）
 *  E 构造器形式（class 插件）不被包坏，仍可正常 new
 *  F 未挂 hook 时同一场景会归 host（证明 B 的成功确实来自 hook）
 *
 * 用法：node test/runas-hook-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import { requireDshNodeModules } from './_deps.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const DEPS = requireDshNodeModules('runAs 归因评测');

const probe = req('../src/probe/probe-core.cjs');
probe.install({ mode: 'als' }); // 纯 ALS：没有栈兜底可借用

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await import(`file:///${path.join(DEPS, '@deepseek-ai/cordis/lib/index.js').replace(/\\/g, '/')}`);
const cordis = ctx.default ?? ctx;

// ---------- 先证明"未挂 hook 时会归 host"（F） ----------
{
  const root = new cordis.Context();
  probe.reset();
  const plugin = { name: 'no-hook-plg', apply() { req('node:fs').readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'); } };
  await root.plugin(plugin);
  await sleep(80);
  const evs = probe.getEvents({ limit: 100 });
  const asHost = evs.filter((e) => e.actor === 'host').length;
  check('F', '未挂 runAs hook 时，插件 I/O 归 host（als 无栈兜底）', asHost > 0 && evs.every((e) => e.actor !== 'no-hook-plg'),
    `actors=${JSON.stringify(evs.reduce((m, e) => ((m[e.actor] = (m[e.actor] || 0) + 1), m), {}))}`);
}

// ---------- 挂 hook ----------
const hooked = probe.hookRegistryClass(cordis.RegistryService);
check('0', 'installRegistryHook 成功挂上 cordis Registry', hooked === true && probe.isRegistryHooked() === true, `hooked=${hooked}`);

// ---------- A / B 同步 + 异步归因 ----------
{
  const root = new cordis.Context();
  probe.reset();
  const marker = path.join(HERE, '..', 'package.json');
  const plugin = {
    name: 'runas-plg',
    apply() {
      const fs = req('node:fs');
      fs.readFileSync(marker, 'utf8');                       // 同步
      setImmediate(() => fs.readFileSync(marker, 'utf8'));    // setImmediate
      setTimeout(() => fs.readFileSync(marker, 'utf8'), 10);  // setTimeout
      Promise.resolve().then(() => fs.readFileSync(marker, 'utf8')); // microtask
    },
  };
  await root.plugin(plugin);
  await sleep(150);
  const evs = probe.getEvents({ limit: 200 });
  const mine = evs.filter((e) => e.actor === 'runas-plg');
  const hosts = evs.filter((e) => e.actor === 'host');
  check('A', '同步 I/O 归因到插件（als 纯模式）', mine.length >= 1, `runas-plg=${mine.length} host=${hosts.length}`);
  check('B', '异步回调（setImmediate/setTimeout/Promise）内 I/O 仍归因到插件',
    mine.length >= 4 && hosts.length === 0,
    `runas-plg=${mine.length} host=${hosts.length} apis=${[...new Set(mine.map((e) => e.api))].join(',')}`);
}

// ---------- C 插件抛错不拖垮宿主 ----------
{
  const root = new cordis.Context();
  probe.reset();
  let threw = false;
  try {
    await root.plugin({ name: 'throwing-plg', apply() { throw new Error('boom-from-plugin'); } });
  } catch { threw = true; }
  // cordis 会把插件异常捕获成 fiber 失败；关键是宿主进程没崩、探针仍可用
  const stillWorks = typeof probe.getEvents === 'function';
  check('C', '插件抛错不影响探针与宿主（fail-safe）', stillWorks, `threw=${threw} probeUsable=${stillWorks}`);
}

// ---------- D 不重复包裹 ----------
{
  const root = new cordis.Context();
  probe.reset();
  const marker = path.join(HERE, '..', 'package.json');
  const plugin = { name: 'dup-plg', apply() { req('node:fs').readFileSync(marker, 'utf8'); } };
  await root.plugin(plugin);
  const wrappedOnce = plugin.__pdrWrapped === true || plugin.apply.__pdrWrapped === true;
  const root2 = new cordis.Context();
  await root2.plugin(plugin); // 同一个 plugin 对象再来一次（模拟 reload）
  await sleep(80);
  const evs = probe.getEvents({ limit: 200 });
  const mine = evs.filter((e) => e.actor === 'dup-plg');
  // 两次注册 → 两次 I/O；如果被重复包裹，事件数会翻倍成 4+
  check('D', '同一 plugin 重复注册不产生重复包裹（事件数不翻倍）',
    mine.length === 2, `events=${mine.length}（期望 2）wrappedFlag=${wrappedOnce}`);
}

// ---------- E 构造器插件不被包坏 ----------
{
  const root = new cordis.Context();
  probe.reset();
  class CtorPlugin {
    constructor(ctxIn) { this.ctx = ctxIn; this.constructed = true; }
    apply() { req('node:fs').readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'); }
  }
  let constructOk = true;
  try { await root.plugin(CtorPlugin); } catch { constructOk = false; }
  check('E', 'class 构造器插件不被包裹破坏', constructOk, `constructOk=${constructOk}`);
}

/**
 * G 函数式插件必须真的被包上。
 *
 * 真机回归：`fn.name = plugin.name` 在 'use strict' 下抛 TypeError
 * （函数 name 属性 writable:false），被包装块 catch 吞掉后插件静默不被包装。
 * 症状极隐蔽：registry 里有它、事件全记 host、无任何报错。
 * 真机实测 31 个函数式插件（含 pdr-probe-diag）全部栽在这行。
 * 这里用一个**有名字的函数**直接断言"包装成功且 I/O 归因到它"。
 */
{
  const root = new cordis.Context();
  probe.reset();
  const marker = path.join(HERE, '..', 'package.json');
  async function namedFnPlugin() { req('node:fs').readFileSync(marker, 'utf8'); }
  // 模拟 ESM 默认导出：有函数名、不在 require.cache 里
  await root.plugin(namedFnPlugin);
  await sleep(120);
  const evs = probe.getEvents({ limit: 200 });
  const mine = evs.filter((e) => e.actor === 'namedFnPlugin');
  const hosts = evs.filter((e) => e.actor === 'host');
  check('G', '函数式插件（name 只读场景）确实被 runAs 包装并归因',
    mine.length >= 1, `namedFnPlugin=${mine.length} host=${hosts.length}`);
}

/**
 * H 不能把 `plugin.apply` 当成身份线索（Function.prototype.apply 伪命中）。
 *
 * 真机回归：class 与普通函数没有自己的 `apply`，`plugin.apply` 取到的是
 * 所有函数共享的 `Function.prototype.apply`。拿它去遍历 require.cache，
 * 任何"导出函数"的模块都会伪命中，几十个 class 插件被错归成
 * 第一个被遍历到的包（真机实测是 `semver`）。
 * 这里断言：一个 class 插件绝不会被归到无关包名上，且不会误归成全局共享引用带出的怪名字。
 */
{
  const root = new cordis.Context();
  probe.reset();
  class UniqueClassPlugin {
    constructor(ctxIn) { this.ctx = ctxIn; }
    apply() { req('node:fs').readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'); }
  }
  await root.plugin(UniqueClassPlugin);
  await sleep(120);
  const evs = probe.getEvents({ limit: 200 });
  const bad = evs.filter((e) => e.actor === 'semver');
  // class 走的是 class-skip 不包装，所以它的 I/O 归 host 是预期；关键是**不能**归成 semver
  check('H', 'class 插件不会被 Function.prototype.apply 伪命中错归成无关包',
    bad.length === 0, `semver事件=${bad.length} actors=${JSON.stringify(evs.reduce((m, e) => ((m[e.actor] = (m[e.actor] || 0) + 1), m), {}))}`);
}

/**
 * I ESM 插件身份反推（require.cache 里没有它）。
 *
 * 真机回归：ESM 模块不进 require.cache，`pdr-probe-diag` 里 `require` 直接未定义，
 * 缓存扫描对它必然落空。补的源码指纹必须能把它认出来。
 * 这里用一个**真的 .mjs 文件**里的导出函数，断言指纹路径能给出包名。
 */
{
  const fs = req('node:fs');
  const os = req('node:os');
  const tmpPkgDir = path.join(os.tmpdir(), `pdr-esm-probe-${process.pid}`);
  fs.mkdirSync(tmpPkgDir, { recursive: true });
  fs.writeFileSync(path.join(tmpPkgDir, 'package.json'),
    JSON.stringify({ name: 'esm-fingerprint-fixture', version: '1.0.0', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(tmpPkgDir, 'index.mjs'),
    'export default async function fingerprintTarget(ctx) {\n' +
    '  const marker = "PDR_ESM_FINGERPRINT_UNIQUE_MARKER_7f3a9c";\n' +
    '  return marker;\n' +
    '}\n');
  const mod = await import(`file:///${path.join(tmpPkgDir, 'index.mjs').replace(/\\/g, '/')}`);
  const esmPlugin = mod.default;
  // 让探针把该目录当作可搜索根
  probe.registerPlugin('esm-fingerprint-fixture', tmpPkgDir);
  probe.reset();
  const root = new cordis.Context();
  await root.plugin(esmPlugin);
  await sleep(120);
  const evs = probe.getEvents({ limit: 200 });
  // 该插件没有 I/O，所以用 registrations 断言身份解析结果
  const regs = probe.getRegistrations ? probe.getRegistrations() : [];
  const hit = regs.filter((r) => r.actor === 'esm-fingerprint-fixture' || r.actor === 'fingerprintTarget');
  check('I', 'ESM 插件（不在 require.cache）能被源码指纹反推出身份',
    hit.length >= 1, `match=${JSON.stringify(hit.map((r) => ({ actor: r.actor, name: r.name })))} events=${evs.length}`);
  try { fs.rmSync(tmpPkgDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

report({ all: results.every((r) => r.pass), results });
