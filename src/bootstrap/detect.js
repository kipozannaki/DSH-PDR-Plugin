/**
 * Runtime Detector + Probe Health Monitor（路线图 v0.3 §4.2 / §4.3）
 *
 * 一条铁律：**健康状态只能由可核验的运行事实推出**，不能拿"插件已加载"当证据。
 * 所以这里的输入全部来自探针的实际计数（包了几个 API、事件归给了谁、丢没丢），
 * 而不是配置声明或设计意图。
 *
 * 本模块保持纯函数（不做 I/O、不读时钟以外的环境），便于单测覆盖每个降级分支。
 */
import os from 'node:os';
import { resolveAdapter, adaptationEvidence } from './adapters.js';

export const RUNTIME_SCHEMA = 'dsh-pdr/runtime/v1';

export const HEALTH = Object.freeze({
  FULL: 'FULL',
  PARTIAL: 'PARTIAL',
  OFFLINE: 'OFFLINE',
});

const HOME_TOKEN = '<home>';
const DSH_HOME_TOKEN = '<DSH_HOME>';

/**
 * 展示用路径脱敏：绝不把用户的真实 home / DSH_HOME 原样写进面板或快照。
 * 只替换前缀，保留有诊断价值的相对结构（profile 名、firewall/ 等）。
 */
export function maskPath(value, opts = {}) {
  if (value === null || value === undefined) return null;
  const norm = String(value).replace(/\\/g, '/');
  if (!norm) return norm;
  const homeRaw = opts.home ?? os.homedir();
  const dshHomeRaw = opts.dshHome ?? process.env.DSH_HOME ?? '';
  const home = String(homeRaw || '').replace(/\\/g, '/');
  const dshHome = String(dshHomeRaw || '').replace(/\\/g, '/');
  const hit = (base, token) => {
    if (!base) return null;
    const b = base.replace(/\/+$/, '');
    if (norm.toLowerCase() === b.toLowerCase()) return token;
    if (norm.toLowerCase().startsWith(b.toLowerCase() + '/')) return token + norm.slice(b.length);
    return null;
  };
  return hit(dshHome, DSH_HOME_TOKEN) ?? hit(home, HOME_TOKEN) ?? norm;
}

/** 统计类判定阈值：样本太小时不拿归因比例下结论（避免启动瞬间误报） */
export const ATTRIBUTION_MIN_SAMPLE = 20;

/**
 * 健康状态判定。
 *
 * @param {object} input
 * @param {object} input.probe       探针快照（installed/preloadRan/registryHooked/hookOrder/dropped/errors）
 * @param {object} input.coverage    probe.getCoverage()
 * @param {object} input.attribution probe.getAttribution()
 * @param {object} input.storage     { dataDir, writable }
 * @param {object} input.adapter     resolveAdapter() 的结果
 * @returns {{state:string, reasons:Array, checks:Array}}
 */
export function evaluateHealth(input = {}) {
  const probe = input.probe ?? {};
  const coverage = input.coverage ?? { categories: [], gaps: [], total: 0, doubleWrapped: 0 };
  const attribution = input.attribution ?? {};
  const storage = input.storage ?? {};
  const adapter = input.adapter ?? { id: 'none', label: '未识别', supported: false, limitation: null };

  const checks = [];
  /**
   * severity 决定"是否降级"：
   *  - 'error'：能力真的缺了（没预载、没挂钩、覆盖有缺口、存储写不了、归因没生效…）
   *  - 'info' ：设计上的取舍（环形缓冲有界，内存里的时间线滚掉旧事件，但磁盘 JSONL 全量保留）
   * 把 info 当降级会让长会话永远到不了 FULL，"完整监控"就失去意义。
   */
  const add = (id, ok, detail, zh, severity = 'error') => {
    checks.push({
      id, ok: ok === true, severity, detail,
      ...(ok === true ? {} : { zh }),
    });
  };

  add('probe-installed', probe.installed === true,
    `installed=${probe.installed === true}`, '运行时探针未安装：本次会话没有行为记录');

  add('preload-ran', probe.preloadRan === true,
    `preloadRan=${probe.preloadRan === true}`,
    '未通过预载注入（缺 --require 窗口）：早于插件入口的 I/O 不可见');

  add('registry-hooked', probe.registryHooked === true,
    `registryHooked=${probe.registryHooked === true}`,
    '插件注册钩子未挂上：归因退回调用栈启发式，覆盖会明显下降');

  add('hook-order', Number(probe.hookOrder) >= 0,
    `hookOrder=${probe.hookOrder}`,
    `Hook 晚于第 ${Number(probe.hookOrder) < 0 ? '全部' : (probe.hookOrder + 1)} 个插件的实例化：先加载的插件可能不可归因`);

  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : [];
  add('coverage-complete', gaps.length === 0,
    `hooked=${coverage.total ?? 0} gaps=[${gaps.join(',')}]`,
    `以下 API 类别没有被 Hook：${gaps.join(', ')}`);

  add('no-double-wrap', Number(coverage.doubleWrapped ?? probe.doubleWrapped ?? 0) === 0,
    `doubleWrapped=${coverage.doubleWrapped ?? probe.doubleWrapped ?? 0}`,
    '检测到重复包装（两份探针？）：事件可能重复计数');

  add('storage-writable', storage.writable !== false,
    `dataDir=${storage.dataDirMasked ?? maskPath(storage.dataDir)} writable=${storage.writable}`,
    '事件存储目录不可写：事件只在内存里，重启即丢');

  // 存储争用（多进程写同一 JSONL）单独成项：它是**可恢复的**写入失败，
  // 与探针内部错误（逻辑缺陷）性质不同，混在一起会掩盖真问题。
  add('no-store-errors', Number(storage.errors ?? 0) === 0,
    `storeErrors=${storage.errors ?? 0}`,
    `事件落盘失败 ${storage.errors} 次（多进程同时写同一 events.jsonl 时的瞬时争用，事件仍在内存中）`);

  add('no-dropped-events', Number(probe.dropped ?? 0) === 0,
    `dropped=${probe.dropped ?? 0}`,
    `内存环形缓冲已满，时间线滚掉了 ${probe.dropped} 条旧事件（磁盘 JSONL 仍保留全量）`,
    'info');

  add('no-probe-errors', Number(probe.errors ?? 0) === 0,
    `errors=${probe.errors ?? 0}`,
    `探针内部错误计数 ${probe.errors}（记录失败但未中断宿主）`);

  // 归因是否真的起作用：样本足够时才判定。
  // 判据要看"有没有任何事件归到具名插件"，而不是只看 host 占比——
  // 宿主自身的启动 I/O 本来就会占绝大多数。
  const sample = Number(attribution.total ?? probe.totalEvents ?? 0);
  const pluginsRegistered = Number(attribution.pluginsRegistered ?? 0);
  const pluginsAttributed = Number(attribution.pluginsAttributed ?? 0);
  const pluginsSeen = Array.isArray(attribution.pluginsSeen) ? attribution.pluginsSeen : [];
  const hostOnly = sample >= ATTRIBUTION_MIN_SAMPLE && pluginsRegistered > 0
    && pluginsAttributed === 0 && pluginsSeen.length === 0
    && Number(attribution.host ?? 0) >= sample * 0.95;
  add('attribution-effective', !hostOnly,
    `sample=${sample} registered=${pluginsRegistered} attributed=${pluginsAttributed} seen=${pluginsSeen.length} host=${attribution.host ?? 0}`,
    `已记录 ${sample} 条事件但没有任何一条归到具名插件（注册 ${pluginsRegistered} 个）：归因未生效`);

  add('adapter-supported', adapter.supported === true,
    `adapter=${adapter.id} supported=${String(adapter.supported)}`,
    adapter.limitation ?? null);

  const failed = checks.filter((c) => !c.ok);
  const toItem = (c) => ({ code: c.id, zh: c.zh ?? c.detail, detail: c.detail, severity: c.severity });
  const reasons = failed.filter((c) => c.severity !== 'info').map(toItem);
  const notes = failed.filter((c) => c.severity === 'info').map(toItem);

  let state;
  if (probe.installed !== true) state = HEALTH.OFFLINE;
  else if (reasons.length > 0) state = HEALTH.PARTIAL;
  else state = HEALTH.FULL;

  return { state, reasons, notes, checks };
}

/**
 * 组装完整的运行时诊断对象（供 API / 面板 / CLI 自检共用）。
 */
export function collectRuntime(input = {}) {
  const env = input.env ?? process.env;
  const proc = input.proc ?? process;
  const probe = input.probe ?? {};
  const coverage = input.coverage ?? { categories: [], gaps: [], total: 0, doubleWrapped: 0 };
  const attribution = input.attribution ?? {};
  const storageIn = input.storage ?? {};
  const now = input.now ?? Date.now();
  const home = input.home ?? os.homedir();
  const dshHome = input.dshHome ?? env.DSH_HOME ?? null;

  const adapter = input.adapter ?? resolveAdapter({ env, probe, proc });
  const evidence = input.adapterEvidence
    ?? (input.adapter ? null : adaptationEvidence({ env, probe, proc }));
  const dataDirMasked = storageIn.dataDir ? maskPath(storageIn.dataDir, { home, dshHome }) : null;
  const health = evaluateHealth({ probe, coverage, attribution, storage: { ...storageIn, dataDirMasked }, adapter });

  return {
    schema: RUNTIME_SCHEMA,
    generatedAt: now,
    runtime: {
      node: input.nodeVersion ?? proc.version ?? process.version,
      platform: proc.platform ?? process.platform,
      arch: proc.arch ?? process.arch,
      pid: proc.pid ?? process.pid,
      dshVersion: input.dshVersion ?? env.DSH_VERSION ?? null,
      profile: input.profile ?? env.PDR_PROFILE ?? null,
      dshHome: maskPath(dshHome, { home, dshHome }),
      home: maskPath(home, { home, dshHome }),
      pluginVersion: input.pluginVersion ?? null,
    },
    bootstrap: {
      adapter: adapter.id,
      label: adapter.label,
      supported: adapter.supported,
      injects: adapter.injects ?? null,
      limitation: adapter.limitation ?? null,
      evidence,
      preloadRequested: env.PDR_PRELOAD_REQUESTED === '1' || env.PDR_BOOTSTRAP === 'launcher',
      preloadRan: probe.preloadRan === true,
    },
    probe: {
      installed: probe.installed === true,
      mode: probe.mode ?? null,
      registryHooked: probe.registryHooked === true,
      hookOrder: Number(probe.hookOrder ?? -1),
      hooksWrapped: Number(coverage.total ?? probe.hooksWrapped ?? 0),
      doubleWrapped: Number(coverage.doubleWrapped ?? probe.doubleWrapped ?? 0),
      dropped: Number(probe.dropped ?? 0),
      errors: Number(probe.errors ?? 0),
      // 错误站点分布：让"errors: 98"可定位，而不是一个不可解释的数字
      errorSites: probe.errorSites && typeof probe.errorSites === 'object' ? probe.errorSites : {},
      blocked: Number(probe.blocked ?? 0),
      totalEvents: Number(probe.totalEvents ?? 0),
    },
    coverage: {
      total: coverage.total ?? 0,
      gaps: coverage.gaps ?? [],
      categories: (coverage.categories ?? []).map((c) => ({ id: c.id, label: c.label, hooked: c.hooked })),
    },
    attribution: {
      total: Number(attribution.total ?? 0),
      host: Number(attribution.host ?? 0),
      unknown: Number(attribution.unknown ?? 0),
      pluginsRegistered: Number(attribution.pluginsRegistered ?? 0),
      pluginsAttributed: Number(attribution.pluginsAttributed ?? 0),
      pluginsSeen: attribution.pluginsSeen ?? [],
    },
    storage: {
      dataDir: dataDirMasked,
      writable: storageIn.writable ?? null,
      errors: Number(storageIn.errors ?? 0),
    },    health,
  };
}

/** 供 CLI 打印的一行摘要 */
export function summarizeRuntime(runtime) {
  const h = runtime.health;
  const parts = [
    `${h.state}`,
    `adapter=${runtime.bootstrap.adapter}`,
    `preload=${runtime.bootstrap.preloadRan ? 'yes' : 'no'}`,
    `hooks=${runtime.probe.hooksWrapped}`,
    `gaps=${runtime.coverage.gaps.length}`,
    `plugins=${runtime.attribution.pluginsAttributed}/${runtime.attribution.pluginsRegistered}`,
  ];
  if (h.reasons.length) parts.push(`reasons=${h.reasons.map((r) => r.code).join('+')}`);
  return parts.join(' ');
}
