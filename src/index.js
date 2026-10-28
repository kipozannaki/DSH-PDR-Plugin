/**
 * DSH-PDR-Plugin · 宿主半边（cordis 插件入口）
 *
 * 装配：探针（观测/归因/规则）→ 插件身份注册（loader 发现 + 显式映射）
 *      → JSONL 本地存储 → 时间线/清单 API（浏览器半边与审计导出的后端）
 *
 * 时序（M0 硬约束）：hook 安装越早越好。cordis.patch.yml 的 earlyInstall 表达式
 * 已在配置物化阶段装好探针；本入口的 install() 是幂等兜底，configure() 补订阅。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJsonlStore } from './store/jsonl.js';
import { healthCard } from './inspector/health-card.js';
import { snapshotProfile, listSnapshots, restoreSnapshot, deleteSnapshot } from './store/snapshot.js';
import { Judge } from './judge/judge.js';
import { deriveContract } from './judge/contract.js';
import { inferContract } from './judge/infer.js';
import { ContractStore } from './judge/contract-store.js';
import { Policy } from './guard/policy.js';
import { createGuard } from './guard/enforce.js';
import { diffDirs, captureVersion } from './update/diff.js';
import { trialInstall } from './update/trial.js';
import { buildCompatReport } from './update/compat.js';
import { generateAuditReport, auditReportMarkdown } from './report/audit.js';
import { buildComplianceExport, toSarif, toCsv } from './report/compliance.js';
import { aggregateSources, profileByActor, redLineSummary, aggregateMarkdown } from './report/aggregate.js';
import { createAlertPusher } from './alert/push.js';
import { bindFirewallApi, mountPanelRoutes } from './panel-host.js';

const req = createRequire(import.meta.url);
const probe = req('./probe/probe-core.cjs');

export const PLUGIN_NAME = 'dsh-pdr-plugin'; // 显示名 DSH-PDR-Plugin（npm 包名强制小写）
// cordis 插件名与服务键（面板 client 半边按它 require 本包）
export const name = PLUGIN_NAME;
// loader 等这些服务就位后才 apply：connection 供面板数据路由，slots 供 client 面板挂载
export const inject = ['connection', 'slots'];
export { Config } from './config.js';

let lastApi = null;
/** 测试/诊断用：拿到最近一次装配的 API（浏览器半边走 ctx.firewall） */
export function getApi() { return lastApi; }

function resolvePackageDir(name, basePaths) {
  try {
    const manifest = req.resolve(name + '/package.json', { paths: basePaths });
    return path.dirname(manifest);
  } catch {
    return null;
  }
}

/** 从 loader entry 发现插件安装目录（best-effort；失败不影响观测） */
function discoverFromLoader(ctx, basePaths) {
  const found = [];
  try {
    const entries = ctx.loader && typeof ctx.loader.entries === 'function' ? ctx.loader.entries() : [];
    for (const entry of entries) {
      const name = entry && entry.options && entry.options.name;
      if (!name || name === PLUGIN_NAME) continue;
      let dir = null;
      if (name.startsWith('.')) {
        // 相对条目（smoke/开发场景）：按 baseUrl 解析
        try {
          const base = (ctx.baseUrl || basePaths[0] || '').replace(/\\/g, '/');
          dir = path.dirname(fileURLToPath(new URL(name, base.startsWith('file:') ? base : pathToFileURL(base + '/').href)));
        } catch { /* 跳过 */ }
      } else {
        dir = resolvePackageDir(name, basePaths);
      }
      if (dir) found.push({ name, dir, entryId: entry.options.id });
    }
  } catch { /* loader 不可用时静默降级（方案 §5.3 降级矩阵） */ }
  return found;
}

export default function firewallPlugin(ctx, config = {}) {
  const dataDir = config.dataDir
    || path.join(process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh'), 'firewall');

  // 1. 探针：幂等安装 + 补配事件订阅（earlyInstall 已装则只补 onEvent）
  // 只在显式指定模式时才传：已装探针的模式由预载/环境变量决定，这里不得覆盖。
  // 默认值（'als'）定义在 probe-core 的 state 里，单一来源。
  const bootMode = config.probeMode || process.env.PDR_PROBE_MODE || null;
  probe.install(bootMode ? { mode: bootMode } : {});
  const store = createJsonlStore({ dir: dataDir, maxBytes: config.maxBytes, keep: config.keep });

  // 越界判定层：声明契约 × 行为基线 × 路径分类（方案 §2"干不干活该干的事"）
  const judge = new Judge({ dataDir, baselineOpts: config.baselineOpts });
  const contractStore = new ContractStore(path.join(dataDir, 'contracts.json'));
  const pluginDirByName = new Map();
  const ensureContract = (name) => {
    if (judge.getContract(name)) return;
    // 优先级：用户覆盖（已确认）> manifest/体检卡派生（草案未确认不生效）
    const userContract = contractStore.get(name);
    if (userContract) { judge.setContract(name, userContract); return; }
    const dir = pluginDirByName.get(name);
    try {
      const card = dir ? healthCard(dir) : null;
      judge.setContract(name, deriveContract({
        name, dir,
        capabilities: (card?.capabilities ?? []).map((c) => c.id),
      }));
    } catch {
      judge.setContract(name, deriveContract({ name, dir }));
    }
  };

  // 拦截器（M2 Block 模式）：默认 alarm-only，Block 需显式开启（方案 §6.1）
  const policy = new Policy(config.policy ?? { mode: 'alarm' });
  const guard = createGuard({
    policy,
    getContract: (name) => { ensureContract(name); return judge.getContract(name); },
    ownDirs: judge.ownDirs,
    pluginDirs: judge.pluginDirs,
  });

  /**
   * 只在"用户显式要求"时才改模式，绝不无条件覆盖。
   * 教训：这里原先写 `config.probeMode || 'both'`，会在插件入口阶段把
   * 预载/earlyInstall 已经选定并已生效的模式改掉（测试里表现为 install 选的 stack 被改成 als/both，
   * 归因结果随之翻转）。模式归属：预载 > 环境变量 > state 默认。
   */
  /**
   * 告警推送（M3 企业特性）。默认关闭——不配置 webhook 就一个字节都不外发。
   * `probe.silent` 必须传：推送走被 hook 的 fetch，不静默会自己给自己记账，
   * 甚至因目标是 http:// 而触发 cleartext-http 红线，形成 record→推送→record 自激。
   */
  const alerts = createAlertPusher({ config: config.alerts ?? {}, silent: probe.silent });

  const explicitMode = config.probeMode || process.env.PDR_PROBE_MODE || null;
  probe.configure({
    ...(explicitMode ? { mode: explicitMode } : {}),
    beforeCall: guard.beforeCall,
    onEvent: (e) => {
      store.append(e);
      // 红线现在是同一事件上的数组（调用内去重）；redLine 保留为兼容首条
      const rules = Array.isArray(e.redLines) ? e.redLines : (e.redLine ? [e.redLine] : []);
      if (rules.length) {
        for (const rule of rules) {
          judge.observeRedFlag({ rule, actor: e.actor, t: e.t });
          // 推送失败绝不影响观测（push 内部已 fail-safe，这里再包一层）
          try {
            alerts.push({ rule, actor: e.actor, t: e.t, api: e.api, target: e.target });
          } catch { /* 推送不得干扰观测 */ }
        }
      } else if (e.actor) { ensureContract(e.actor); judge.observe(e); }
    },
  });

  // 插件入口 runAs 包裹：用本插件自己的 ctx 反推 RegistryService（唯一可靠来源，见 probe-core 注释）。
  // 挂上之后，**后续**加载的插件都会在 ALS 上下文里实例化，归因不依赖调用栈。
  probe.installRegistryHook(ctx);

  // 2. 自观测排除 + 插件身份注册
  probe.registerPlugin(PLUGIN_NAME, path.dirname(fileURLToPath(import.meta.url)));
  probe.addIgnoredActor(PLUGIN_NAME);
  const basePaths = [config.baseUrl || (typeof ctx !== 'undefined' && ctx.baseUrl) || process.cwd()]
    .filter(Boolean).map((p) => String(p).replace(/^file:\//, ''));
  const registerAll = (list) => {
    for (const p of list) {
      probe.registerPlugin(p.name, p.dir);
      if (!pluginDirByName.has(p.name)) {
        pluginDirByName.set(p.name, p.dir);
        judge.registerPlugin(p.name, p.dir);
      }
    }
  };
  registerAll(config.plugins || []);
  registerAll(discoverFromLoader(ctx, basePaths));

  // 3. API（浏览器半边 / 审计导出 / 体检卡共用的后端面）
  const api = {
    /** 行为时间线：按插件归属、旗标、时间范围检索 */
    getEvents: (filter) => probe.getEvents(filter),
    getRedFlags: () => probe.getRedFlags(),
    /** 总览：每插件行为计数 + 红线 + 探针健康 */
    getSummary: () => probe.getSummary(),
    getStats: () => probe.getStats(),
    /** 装前体检卡（静态初筛，PASS/WARN/BLOCK） */
    healthCard: (packageDir) => healthCard(packageDir),
    /** 快照 / 回滚（profile 清单三件套） */
    snapshotProfile: (profileDir, tag) => snapshotProfile({ profileDir, dataDir, tag }),
    listSnapshots: () => listSnapshots({ dataDir }),
    restoreSnapshot: (id, opts) => restoreSnapshot({ dataDir, profileDir: (opts && opts.profileDir) || config.profileDir || process.cwd(), id, dryRun: !!(opts && opts.dryRun) }),
    deleteSnapshot: (id) => deleteSnapshot({ dataDir, id }),
    /** 越界判定：每插件违规/分级（正常/观察/可疑/越界）+ 契约 + 基线画像 */
    getVerdicts: () => judge.getVerdicts(),
    getVerdict: (name) => judge.getVerdict(name),
    setContract: (name, contract) => judge.setContract(name, contract),
    saveBaseline: () => judge.save(),
    /** 拦截策略（M2 Block 模式）：默认 alarm-only，setPolicy 显式开启 block */
    getPolicy: () => policy.toJSON(),
    setPolicy: (p) => policy.update(p ?? {}),
    getGuardStats: () => ({ blocked: probe.getStats().blocked, policy: policy.toJSON() }),
    /** 更新守护（M2）：更新 diff + 隔离试装 */
    getUpdateDiff: (beforeDir, afterDir) => diffDirs(beforeDir, afterDir),
    captureVersion: (dir) => captureVersion(dir),
    trialInstall: (pluginDir, opts) => trialInstall({ pluginDir, ...(opts ?? {}) }),
    /** M3：企业审计报告（JSON + Markdown）+ 兼容证据（upstream-radar 对接地基） */
    getAuditReport: () => generateAuditReport(api),
    getAuditMarkdown: () => auditReportMarkdown(generateAuditReport(api)),
    getCompatReport: (name, { trial = null, diff = null, version = '' } = {}) =>
      buildCompatReport({ name, version, trial, diff }),
    /** M3：告警推送（默认关闭；配置见 config.alerts，stats 用于排障） */
    getAlertStats: () => alerts.stats(),
    configureAlerts: (next) => { alerts.update(next); return alerts.stats(); },
    /** 测试/运维用：手动推一条（不经过红线判定），验证 webhook 可达 */
    testAlert: (rule = 'test-alert') => alerts.push({
      rule, actor: PLUGIN_NAME, t: Date.now(), api: 'test', target: null,
    }),
    /**
     * M3：合规导出。返回 {schema, generatedAt, disclaimer, artifacts:{sarif,csv,json}}。
     * 只导出**格式**，不生成合规结论——那属于认证机构，不属于本工具。
     */
    getComplianceExport: ({ formats = ['sarif', 'csv', 'json'], uriBase = null } = {}) =>
      buildComplianceExport(generateAuditReport(api), { formats, uriBase }),
    getSarif: (opts) => toSarif(generateAuditReport(api), opts ?? {}),
    getCsv: () => toCsv(generateAuditReport(api)),
    /**
     * M3：多源汇总（多 profile / 多机 / 归档）。sources 为数据目录列表，
     * 不传则汇总当前 dataDir。
     */
    getAggregateReport: (sources = [dataDir], opts = {}) => {
      const agg = aggregateSources(sources, opts);
      return { ...agg, actors: profileByActor(agg.events), redLines: redLineSummary(agg.events) };
    },
    getAggregateMarkdown: (sources = [dataDir], opts = {}) => aggregateMarkdown(aggregateSources(sources, opts)),
    /** 契约推断：从行为迹生成草案（未确认不生效；推断不赦免红线现场） */
    inferContracts: () => {
      const byActor = new Map();
      for (const e of probe.getEvents({ limit: 5000 })) {
        if (!e.actor || e.actor === 'host' || e.actor === 'self') continue;
        const list = byActor.get(e.actor) ?? [];
        list.push(e);
        byActor.set(e.actor, list);
      }
      const drafts = [];
      for (const [actor, events] of byActor) {
        let capabilities = [];
        const dir = pluginDirByName.get(actor);
        try {
          capabilities = dir ? (healthCard(dir).capabilities ?? []).map((c) => c.id) : [];
        } catch { /* 能力提取失败按空处理 */ }
        const draft = inferContract({
          name: actor, events, capabilities,
          ownDirs: judge.ownDirs.get(actor) ?? [],
          pluginDirs: judge.pluginDirs,
        });
        contractStore.setDraft(actor, draft);
        drafts.push(draft);
      }
      contractStore.save();
      return drafts;
    },
    /** 确认草案 → 生效（用户点头的动作） */
    adoptContract: (name) => {
      const c = contractStore.adopt(name);
      if (c) judge.setContract(name, c);
      return c;
    },
    rejectContract: (name) => contractStore.reject(name),
    listContracts: () => ({
      ...contractStore.list(),
      active: judge.getVerdicts().map((v) => ({ name: v.actor, source: v.contract?.source ?? null, scope: v.contract?.scope ?? null })),
    }),
    /** 数据位置（本地优先，导出给用户自查） */
    dataDir,
    eventLogPath: store.path,
  };

  // 4.5 行为监控面板：数据路由（connection.fetch 缝）+ client bundle 的数据源。
  // mountPanelRoutes 是重试式的：本插件 fiber 可能先于 connection 服务激活，
  // 服务就位后路由才挂上；期间面板显示"数据通道未接入"，主功能不受影响。
  bindFirewallApi(api);
  api.panelRoutes = mountPanelRoutes(ctx);

  // 5. 宿主 web 挂载（fail-safe：异步尝试，dsh-h3 缺位/失败都不影响主功能）
  api.webMount = { ok: false, mode: 'pending' };
  import('./client/api-handlers.mjs')
    .then(({ createLiveSource }) => import('./host-web.js')
      .then(({ mountFirewallWeb }) => mountFirewallWeb({ ctx, source: createLiveSource(api) })))
    .then((r) => { api.webMount = r; })
    .catch((e) => { api.webMount = { ok: false, mode: 'error', error: String(e?.message ?? e) }; });

  // 4. 暴露给其他插件 / 浏览器半边（provide 不可用时降级为直接挂载）
  try {
    if (typeof ctx.provide === 'function') ctx.provide('firewall');
    ctx.firewall = api;
  } catch { /* ctx 代理形态差异不阻塞启动 */ }
  lastApi = api;

  return api;
}
