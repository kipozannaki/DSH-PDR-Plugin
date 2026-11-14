/**
 * Bootstrap 适配层（路线图 v0.3 §4.1）
 *
 * 把「探针怎么进入宿主进程」与「探针装进来之后做什么」解耦。
 *
 * 为什么要解耦：探针必须在**一切插件模块求值之前**装好——ESM facade 在首次
 * 求值时就固化具名导出的函数值，晚装必然漏掉早于插件的 I/O。当前唯一经过
 * 真机验证的注入点是 Node 的 `--require` 预载（NODE_OPTIONS），它要求我们
 * 控制宿主的启动命令行。于是"能不能注入"取决于**启动入口**，而不是探针本身。
 *
 * 本文件只描述"有哪些入口、各自可不可用、为什么"，不做任何 I/O，便于单测。
 * 判定结果必须落到 `supported`，不允许把"理论上可行"标成支持（§4.1 验收标准）。
 */

export const ADAPTER_SCHEMA = 'dsh-pdr/adapter/v1';

/** 桌面应用进程特征：宿主由 Tauri 应用自身拉起，命令行不由用户控制 */
export function desktopEvidence(proc = process, env = process.env) {
  if (env.DSH_DESKTOP === '1') return 'env:DSH_DESKTOP=1';
  if (env.DSH_TAURI === '1') return 'env:DSH_TAURI=1';
  const candidates = [
    [proc.execPath, 'execPath'],
    [proc.argv && proc.argv[1], 'argv[1]'],
    [env.ORIGINAL_XDG_CURRENT_DESKTOP, 'ORIGINAL_XDG_CURRENT_DESKTOP'],
  ];
  for (const [value, label] of candidates) {
    if (!value) continue;
    if (/dsh[-_ ]?tauri|deepseek[-_ ]?harness[-_ ]?desktop/i.test(String(value))) {
      return `${label}:${String(value).replace(/\\/g, '/').slice(0, 90)}`;
    }
  }
  return null;
}

export function looksLikeDesktop(proc = process, env = process.env) {
  return desktopEvidence(proc, env) !== null;
}

/**
 * 适配器目录。顺序即优先级（越靠前越"可信"，因为证据越硬）。
 *
 * supported:
 *   true       —— 有真实环境验证，注入可靠
 *   'degraded' —— 能装，但缺失预载窗口，归因能力有缺口
 *   false      —— 无法注入，该会话必须被明确标成未监控
 */
export const ADAPTERS = [
  {
    id: 'launcher',
    label: 'dsh-pdr 启动器',
    supported: true,
    injects: 'NODE_OPTIONS=--require <plugin>/src/probe/preload.cjs',
    detect: (env) => env.PDR_BOOTSTRAP === 'launcher',
    limitation: null,
    verify: '宿主启动后 stats.preloadRan=true 且 registryHooked=true',
  },
  {
    id: 'preload',
    label: '外部 NODE_OPTIONS 预载',
    supported: true,
    injects: 'NODE_OPTIONS=--require <plugin>/src/probe/preload.cjs',
    detect: (env, probe) => env.PDR_PRELOAD_RAN === '1' || probe.preloadRan === true,
    limitation: '需调用方自行注入 NODE_OPTIONS（自建启动脚本、CI、包装器）',
    verify: 'PDR_PRELOAD_RAN=1 或 stats.preloadRan=true',
  },
  {
    id: 'desktop',
    label: 'DSH Desktop 运行时',
    supported: 'degraded',
    injects: null,
    detect: (env, probe, proc) => looksLikeDesktop(proc, env),
    /**
     * 实测口径（v0.3）：进程跑在 Desktop 自带 runtime（DSH Tauri.exe）里。
     * 由桌面应用直接启动的会话拿不到 --require 窗口；从 shell 手动用该 runtime
     * 启动的会话则**可能**能注入。两种都不能宣称"完整支持"，
     * 所以标记为 degraded，真实覆盖由健康状态按证据给出。
     */
    limitation: '运行在 DSH Desktop 自带运行时里：默认没有 --require 预载窗口，归因覆盖取决于实际启动方式，不宣称完整支持',
    verify: '健康状态实测：有探针则 PARTIAL，无探针则 OFFLINE',
  },
  {
    id: 'bundle',
    label: 'bundle earlyInstall（宿主内晚装）',
    supported: 'degraded',
    injects: 'cordis.patch.yml 的 earlyInstall !!js',
    detect: (env, probe) => probe.installed === true,
    limitation: '缺预载窗口：早于插件入口的 I/O 不可见，ESM facade 快照可能与 hook 顺序错位',
    verify: 'stats.bootstrap="bundle"',
  },
  {
    id: 'none',
    label: '未识别',
    supported: false,
    injects: null,
    detect: () => true,
    limitation: '未检测到预载或早装痕迹；本次会话没有运行时监控',
    verify: '—',
  },
];

/** 服务端可下发的矩阵（CLI 自检 / 文档共用，不泄漏探测函数） */
export function adapterMatrix() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    supported: a.supported,
    injects: a.injects,
    limitation: a.limitation,
    verify: a.verify,
  }));
}

/**
 * 判定当前进程用的是哪个入口。
 * @param {object} input
 * @param {object} [input.env]
 * @param {object} [input.probe] 探针快照（installed / preloadRan / bootstrap）
 * @param {object} [input.proc]
 */
export function resolveAdapter(input = {}) {
  const env = input.env ?? process.env;
  const probe = input.probe ?? {};
  const proc = input.proc ?? process;
  for (const a of ADAPTERS) {
    let hit = false;
    try { hit = a.detect(env, probe, proc) === true; } catch { hit = false; }
    if (hit) return a;
  }
  return ADAPTERS[ADAPTERS.length - 1];
}

/**
 * 判定依据（供面板/doctor 解释"为什么是这个入口"）。
 * 没有依据的判定等于猜测——安全工具的每个结论都该能回溯到证据。
 */
export function adaptationEvidence(input = {}) {
  const env = input.env ?? process.env;
  const probe = input.probe ?? {};
  const proc = input.proc ?? process;
  const id = (resolveAdapter({ env, probe, proc }) || {}).id;
  if (id === 'launcher') return 'env:PDR_BOOTSTRAP=launcher';
  if (id === 'preload') return env.PDR_PRELOAD_RAN === '1' ? 'env:PDR_PRELOAD_RAN=1' : 'probe.preloadRan=true';
  if (id === 'desktop') return desktopEvidence(proc, env) ?? 'desktop heuristic';
  if (id === 'bundle') return `probe.bootstrap=${probe.bootstrap ?? 'bundle'}`;
  return null;
}
