/**
 * v0.3 §4.1/§4.2/§4.3 验收：Bootstrap 适配层 + Runtime Detector + Probe Health Monitor
 *
 * 这一套测的是"状态判定是否基于可核验的运行事实"：
 * 每个降级分支都必须由**具体证据**触发（没预载 / 没挂注册钩子 / Hook 晚到 /
 * 覆盖有缺口 / 丢事件 / 归因全落 host），而不是靠配置声明或"插件已加载"。
 *
 * 另有两条独立断言：
 *   - 路径脱敏（面板/快照不得出现真实 home、DSH_HOME 原文）
 *   - 单次装配（两份探针副本不得产生双层包装）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { report } from './_report.mjs';
import { collectRuntime, maskPath, HEALTH } from '../src/bootstrap/detect.js';
import { resolveAdapter, adapterMatrix } from '../src/bootstrap/adapters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: pass === true, detail });

const GREEN = {
  probe: { installed: true, preloadRan: true, registryHooked: true, hookOrder: 0, dropped: 0, errors: 0, mode: 'als', blocked: 0, totalEvents: 100 },
  coverage: { total: 51, gaps: [], categories: [
    { id: 'fs', label: 'fs', hooked: 22 }, { id: 'fs-promises', label: 'fs/promises', hooked: 15 },
    { id: 'child_process', label: 'child_process', hooked: 6 }, { id: 'http', label: 'HTTP(S)', hooked: 4 },
    { id: 'net', label: 'TCP/TLS', hooked: 3 }, { id: 'fetch', label: 'fetch', hooked: 1 },
  ], doubleWrapped: 0 },
  attribution: { total: 100, host: 20, unknown: 0, pluginsRegistered: 4, pluginsAttributed: 3, pluginsSeen: ['a', 'b', 'c'] },
  storage: { dataDir: '/home/u/.dsh/firewall', writable: true },
};
const LAUNCHER = resolveAdapter({ env: { PDR_BOOTSTRAP: 'launcher' }, probe: {}, proc: {} });
const mk = (over = {}) => collectRuntime({
  ...GREEN, ...over,
  probe: { ...GREEN.probe, ...(over.probe || {}) },
  coverage: { ...GREEN.coverage, ...(over.coverage || {}) },
  attribution: { ...GREEN.attribution, ...(over.attribution || {}) },
  storage: { ...GREEN.storage, ...(over.storage || {}) },
  adapter: over.adapter ?? LAUNCHER,
  env: over.env ?? {}, proc: over.proc ?? {}, home: '/home/u', dshHome: '/home/u/.dsh',
  nodeVersion: 'v24.2.0', dshVersion: '0.2.1-rc.4', pluginVersion: '0.3.0', now: 1_700_000_000_000,
});

/** 正例：全绿 → FULL，且不带任何原因 */
{
  const r = mk();
  check('A', '全绿 → FULL（无原因）', r.health.state === HEALTH.FULL && r.health.reasons.length === 0,
    `state=${r.health.state} reasons=${r.health.reasons.map((x) => x.code).join(',') || 'none'}`);
}

/** 反例 1：探针没装 → OFFLINE（哪怕别的字段看起来正常） */
{
  const r = mk({ probe: { installed: false } });
  const codes = r.health.reasons.map((x) => x.code);
  check('B', '探针未安装 → OFFLINE（不是 PARTIAL）',
    r.health.state === HEALTH.OFFLINE && codes.includes('probe-installed'),
    `state=${r.health.state} reasons=${codes.join(',')}`);
}

/** 反例 2..6：各降级分支都必须 PARTIAL，且原因可定位 */
const partialCases = [
  ['C', '缺预载（只在插件入口晚装）→ PARTIAL', { probe: { preloadRan: false } }, 'preload-ran'],
  ['D', '注册钩子未挂 → PARTIAL', { probe: { registryHooked: false } }, 'registry-hooked'],
  ['E', 'Hook 晚于插件实例化 → PARTIAL', { probe: { hookOrder: -1 } }, 'hook-order'],
  ['F', '覆盖存在缺口 → PARTIAL', { coverage: { gaps: ['fetch'], categories: [{ id: 'fs', label: 'fs', hooked: 22 }] } }, 'coverage-complete'],
  ['H', '探针内部错误 → PARTIAL', { probe: { errors: 3 } }, 'no-probe-errors'],
  ['I', '存储不可写 → PARTIAL', { storage: { writable: false } }, 'storage-writable'],
  ['I2', '存储写入失败（争用）→ PARTIAL', { storage: { errors: 5 } }, 'no-store-errors'],
];
for (const [id, label, over, code] of partialCases) {
  const r = mk(over);
  check(id, label + `（原因=${code}）`,
    r.health.state === HEALTH.PARTIAL && r.health.reasons.some((x) => x.code === code),
    `state=${r.health.state} reasons=${r.health.reasons.map((x) => x.code).join(',')}`);
}

/** 归因未生效：样本足够且插件已识别，却全部落 host */
{
  const r = mk({ attribution: { total: 100, host: 100, unknown: 0, pluginsRegistered: 4, pluginsAttributed: 0, pluginsSeen: [] } });
  const hit = r.health.reasons.some((x) => x.code === 'attribution-effective');
  check('J', '事件全归 host 且插件已识别 → 判定归因未生效', r.health.state === HEALTH.PARTIAL && hit,
    `state=${r.health.state} reasons=${r.health.reasons.map((x) => x.code).join(',')}`);
}

/** 环形缓冲滚掉旧事件是**设计取舍**（info），不该把长会话判成降级 */
{
  const r = mk({ probe: { dropped: 42 } });
  const hitNote = (r.health.notes || []).some((x) => x.code === 'no-dropped-events');
  check('G', '事件被丢弃 → 记为 info 提示（不降级，磁盘仍全量）',
    r.health.state === HEALTH.FULL && hitNote && !r.health.reasons.some((x) => x.code === 'no-dropped-events'),
    `state=${r.health.state} notes=${(r.health.notes || []).map((x) => x.code).join(',') || 'none'}`);
}
{
  const r = mk({ attribution: { total: 3, host: 3, unknown: 0, pluginsRegistered: 4, pluginsAttributed: 0, pluginsSeen: [] } });
  check('K', '样本不足（3 条）时不因归因比例判降级',
    !r.health.reasons.some((x) => x.code === 'attribution-effective'),
    `state=${r.health.state} reasons=${r.health.reasons.map((x) => x.code).join(',') || 'none'}`);
}

/** 双层包装是可观测缺陷 */
{
  const r = mk({ coverage: { doubleWrapped: 2 } });
  check('L', '检测到重复包装 → PARTIAL', r.health.state === HEALTH.PARTIAL
    && r.health.reasons.some((x) => x.code === 'no-double-wrap'),
    `state=${r.health.state}`);
}

/** 适配器识别矩阵 */
{
  const cases = [
    ['launcher', { PDR_BOOTSTRAP: 'launcher' }, {}],
    ['preload', { PDR_PRELOAD_RAN: '1' }, {}],
    ['desktop', {}, { execPath: 'C:/apps/DSH Tauri/app.exe' }],
    ['bundle', {}, {}, { installed: true }],
    ['none', {}, {}],
  ];
  const got = cases.map(([want, env, proc, probe]) => {
    const a = resolveAdapter({ env, proc, probe: probe ?? {} });
    return a.id === want ? null : `${want}->${a.id}`;
  }).filter(Boolean);
  check('M', '启动入口识别：launcher/preload/desktop/bundle/none', got.length === 0, got.join(',') || 'all matched');
}

/** Desktop 运行时：未验证 → 只能是 degraded（不宣称支持），且健康状态降级并给出原因 */
{
  const desktop = resolveAdapter({ env: {}, probe: { installed: true }, proc: { execPath: 'C:/apps/DSH Tauri/app.exe' } });
  const r = mk({ adapter: desktop, probe: { installed: true } });
  check('N', 'Desktop 运行时：supported=degraded（不宣称支持）且健康降级并给出原因',
    desktop.supported === 'degraded' && r.health.state === HEALTH.PARTIAL
    && r.health.reasons.some((x) => x.code === 'adapter-supported'),
    `supported=${desktop.supported} state=${r.health.state} reasons=${r.health.reasons.map((x) => x.code).join(',')}`);
}

/** 路径脱敏：真实 home / DSH_HOME 不得出现在诊断对象里 */
{
  const r = mk({ storage: { dataDir: '/home/u/.dsh/firewall', writable: true } });
  const text = JSON.stringify(r);
  check('O', '路径脱敏：快照里不出现真实 home / DSH_HOME 原文',
    r.runtime.dshHome === '<DSH_HOME>' && r.storage.dataDir === '<DSH_HOME>/firewall'
    && !text.includes('/home/u'),
    `dshHome=${r.runtime.dshHome} dataDir=${r.storage.dataDir}`);
}

/** maskPath 单元行为 */
{
  const wins = maskPath('C:\\Users\\bob\\.dsh\\firewall', { home: 'C:\\Users\\bob', dshHome: 'C:\\Users\\bob\\.dsh' });
  check('P', 'maskPath 归一 Windows 反斜杠并替换前缀', wins === '<DSH_HOME>/firewall', `got=${wins}`);
}

/** 单次装配：第二份探针副本不得产生第二层包装 */
{
  const src = path.join(HERE, '..', 'src', 'probe', 'probe-core.cjs');
  const first = req(src);
  first.install({ mode: 'als' });
  const covA = first.getCoverage();

  // 模拟"进程里出现第二份探针副本"：清掉全局单例，换成同文件的副本
  delete globalThis[Symbol.for('dsh-pdr-plugin.probe-core')];
  const tmp = path.join(os.tmpdir(), `pdr-probe-copy-${process.pid}.cjs`);
  fs.copyFileSync(src, tmp);
  const second = req(tmp);
  second.install({ mode: 'als' });
  const covB = second.getCoverage();

  // 断言：第二份一个 Hook 都没加（全被守卫拦下），且把重复包装记成了可观测计数
  const noNewHooks = covB.total === 0;
  const guardWorked = covB.doubleWrapped > 0;
  // 功能未被破坏：包装后的 fs 仍然能正常读
  const readable = req('node:fs').readFileSync(path.join(HERE, '..', 'package.json'), 'utf8').length > 0;
  check('Q', '两份探针副本 → 不产生双层包装（重复包装被拦并计数）',
    noNewHooks && guardWorked && readable,
    `first=${covA.total} hooks, second=${covB.total} hooks, doubleWrapped=${covB.doubleWrapped}, readable=${readable}`);
  try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
}

/** 预载痕迹：markPreload 后 bootstrap=preload，重复标记不覆盖 */
{
  const probe = req(path.join(HERE, '..', 'src', 'probe', 'probe-core.cjs'));
  probe.markPreload();
  probe.markBootstrap('bundle'); // 不应覆盖已确定的 preload
  const stats = probe.getStats();
  check('R', '预载痕迹：bootstrap 保持 preload（bundle 兜底不覆盖）',
    stats.preloadRan === true && stats.bootstrap === 'preload',
    `preloadRan=${stats.preloadRan} bootstrap=${stats.bootstrap}`);
}

/** 覆盖矩阵分类口径：每个声明的类别都能映射到实际 API */
{
  const probe = req(path.join(HERE, '..', 'src', 'probe', 'probe-core.cjs'));
  const cov = probe.getCoverage();
  const ids = cov.categories.map((c) => c.id);
  const want = ['fs', 'fs-promises', 'child_process', 'http', 'net', 'fetch'];
  check('S', '覆盖矩阵含全部 6 个类别且无缺口（当前构建）',
    want.every((w) => ids.includes(w)) && cov.gaps.length === 0,
    `ids=${ids.join(',')} gaps=${cov.gaps.join(',') || 'none'} total=${cov.total}`);
}

/** CLI 矩阵一致性：adapters.js 与启动器自检的 supported 口径一致 */
{
  const m = adapterMatrix();
  const launcher = m.find((a) => a.id === 'launcher');
  const desktop = m.find((a) => a.id === 'desktop');
  const bundle = m.find((a) => a.id === 'bundle');
  const none = m.find((a) => a.id === 'none');
  check('T', '适配器矩阵口径：launcher=true / desktop=degraded / bundle=degraded / none=false',
    launcher?.supported === true && desktop?.supported === 'degraded'
    && bundle?.supported === 'degraded' && none?.supported === false,
    m.map((a) => `${a.id}=${a.supported}`).join(' '));
}

const passed = results.filter((r) => r.pass).length;
report({
  all: passed === results.length,
  passed,
  total: results.length,
  results,
});
