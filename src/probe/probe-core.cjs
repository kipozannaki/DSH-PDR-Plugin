'use strict';
/**
 * DSH-PDR-Plugin · 探针核心（CJS，进程内 hook + 行为归因 + 红线规则）
 *
 * 设计依据：M0 技术验证报告（../../research/M0-技术验证报告.md）
 *  - 归因三级：ALS 快路径（发起者归因）→ 栈归因（file:// URL 归一 + 目录 realpath 映射）→ 'host'
 *  - 时序硬约束：patch 必须早于任何插件模块 import（ESM facade 固化），
 *    本文件被 cordis.patch.yml 的 earlyInstall 表达式同步 require，就是为此
 *  - 有界记账：环形缓冲 + 窗口化规则（M0 实测无界 filter 会 O(n²) 自我 DoS）
 *  - fail-safe：所有 hook try/catch 到顶，观测失败静默降级，绝不抛给宿主（方案 §6.3）
 *
 * 能力边界（诚实声明，方案 §6.4）：
 *  进程内 hook 可被蓄意绕过（process.binding / 原生模块 / 子进程代理）。
 *  本层定位是"持续、可归因的可见性"，不是对抗级沙箱；反制检测是独立层。
 */
// 单例：预载（--require）与 bundle earlyInstall 可能加载不同副本（file:/pnpm 复制）。
// 两份各自 install 会把 fs 包装两层，__orig 指向包装器 → 记账自我递归。
// 用全局符号让同一进程只保留一份探针状态与包装。
const SINGLETON_KEY = Symbol.for('dsh-pdr-plugin.probe-core');
if (globalThis[SINGLETON_KEY]) {
  module.exports = globalThis[SINGLETON_KEY];
} else {
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { fileURLToPath } = require('node:url');

const als = new AsyncLocalStorage();

const state = {
  installed: false,
  /**
   * 归因模式默认 'als'。
   * M0 终审实测（真实工作负载回放，1552 个真实只读操作）：
   *   als +0.6% ／ stack +206% ／ both +218%
   * 栈归因每次操作都要 Error.captureStackTrace，成本两个数量级高于 ALS 快路径。
   * 方案 §5.3 的 <2% 门槛只有 'als' 达标，所以默认必须是它；
   * stack/both 保留为诊断兜底（ALS 失效时手动 PDR_PROBE_MODE=stack）。
   */
  mode: 'als', // 'als' | 'stack' | 'both'
  plugins: new Map(), // realpath 目录(正斜杠) -> 插件名
  events: [],
  redFlags: [],
  maxEvents: 50_000,
  ruleWindow: 200,
  totalEvents: 0,
  droppedEvents: 0,
  onEvent: null,
  beforeCall: null, // (actor, api, target) => {action, rule, reason} | null；block 时抛错
  errors: 0,
  blockedCount: 0,
  ignoreActors: new Set(),
  ignoreDirs: new Set(), // realpath 目录：命中即 'self'，不记账（防自反馈循环）
  inHook: 0,
  /**
   * 静默计数（产品自身发的"合法出网"用）：
   * 告警推送到用户配置的 webhook 时，请求会走被 hook 的 fetch/https，
   * 若不静默，就会自己给自己记账（还可能触发 cleartext-http 红线）——
   * record→推送→record 的自激。
   * 与 inHook 分开：inHook 是"解析参数期间不记账"的窄守卫，
   * 这里是"整段产品动作都不记账"，且必须是显式、可审计的开关（不是静默后门）。
   */
  silentDepth: 0,
  netParent: 0, // 网络父调用计数（http.request 嵌套 net.connect 时跨层去重）
  registryHooked: false, // cordis RegistryService.plugin 是否已包 runAs
  registryEarlyTried: false, // 预载期 Module._load 拦截是否已尝试
  hookOrder: -1, // 挂钩发生在第几次 plugin() 调用之前（诊断用，-1 = 从来没赶上）
  fdPaths: new Map(), // open() 返回的 fd -> 路径（写事件反查真路径用）
  registrations: [], // 最近 N 次 plugin() 入参形态（诊断 runAs 归因失败用，非记账）
  fingerprintRoots: [], // ESM 插件的源码指纹搜索根（profile/node_modules 等）
};

// 自观测代码目录：探针 + 存储 + 体检卡（src/），任何来自这里的 I/O 都是自观测
// 注意不是整个包根：test/ 等目录里的插件样本必须正常归因
const SELF_ROOT = path.resolve(__dirname, '..').replace(/\\/g, '/');

/** 拦截错误：受控地抛给插件（不是宿主崩溃），code 供插件/UI 识别 */
class FirewallBlockError extends Error {
  constructor(reason, info = {}) {
    super(`DSH-PDR-Plugin blocked: ${reason || info.api || 'operation'}`);
    this.name = 'FirewallBlockError';
    this.code = 'DSH_PDR_BLOCKED';
    this.rule = info.rule;
    this.api = info.api;
    this.target = info.target;
  }
}

// ---------- 插件注册与归因 ----------

function registerPlugin(name, dir) {
  let real = dir;
  try { real = require('node:fs').realpathSync(dir); } catch { /* 实验/未安装环境允许不存在 */ }
  const key = real.replace(/\\/g, '/');
  // 先注册者优先：防止 loader 发现逻辑用条目名覆盖既有映射（M1 smoke 实测教训）
  if (!state.plugins.has(key)) state.plugins.set(key, name);
  // 顺带登记源码指纹搜索根：插件目录的父目录（即 node_modules）就是"同类插件"所在，
  // ESM 插件反推只能在这一层里找。自动推导，调用方无需额外配置。
  try {
    const parent = path.dirname(key);
    if (parent && parent !== key && state.fingerprintRoots.length < 8 && !state.fingerprintRoots.includes(parent)) {
      state.fingerprintRoots.push(parent);
      fingerprintCorpus = null; // 根变了，语料作废
    }
  } catch { /* 根推导失败只影响 ESM 反推 */ }
}

function addIgnoredActor(name) { state.ignoreActors.add(name); }
function addIgnoredDir(dir) {
  let real = dir;
  try { real = require('node:fs').realpathSync(dir); } catch { /* 容错 */ }
  state.ignoreDirs.add(real.replace(/\\/g, '/'));
}

function runAs(actor, fn, ...args) {
  return als.run({ actor }, fn, ...args);
}

/**
 * 在"不记账"窗口内执行（产品自身发起的合法动作：告警推送等）。
 * 只影响记账与红线判定，不改变拦截行为；嵌套安全（计数式）。
 * 任何异常都照常向上抛——静默的是观测，不是错误。
 */
function silent(fn) {
  state.silentDepth++;
  try {
    return fn();
  } finally {
    state.silentDepth--;
  }
}

function classifyFile(file) {
  if (!file) return null;
  let norm;
  if (file.startsWith('file://')) {
    try { norm = fileURLToPath(file); } catch { return null; }
    norm = norm.replace(/\\/g, '/');
  } else {
    norm = file.replace(/\\/g, '/');
  }
  if (norm === __filename.replace(/\\/g, '/')) return 'skip';
  if (norm.startsWith('node:')) return 'skip';
  // 自观测：按路径判定（与名字映射解耦，防自反馈）
  if (norm.startsWith(SELF_ROOT + '/')) return 'self';
  for (const d of state.ignoreDirs) if (norm.startsWith(d + '/')) return 'self';
  for (const [dir, name] of state.plugins) {
    if (norm.startsWith(dir + '/')) return name;
  }
  // 未注册帧：现场解析 package.json（真机实测——注册可能晚于插件 I/O，不能依赖预注册）
  const pkg = packageForFile(norm);
  if (pkg && pkg !== SELF_PKG && !pkg.startsWith('@deepseek-ai/')) return pkg;
  return 'host';
}

// 防火墙自身包名（其非 src/ 代码如测试 harness 归 'host'，src/ 归 'self'）
const SELF_PKG = (() => {
  try { return JSON.parse(require('node:fs').readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).name; } catch { return 'dsh-pdr-plugin'; }
})();

// 帧路径 → 包名 的现场解析缓存（dir -> name|null）
const _pkgCache = new Map();
function packageForFile(normFile) {
  const fs = require('node:fs');
  const rawExists = fs.existsSync.__orig || fs.existsSync;
  const rawRead = fs.readFileSync.__orig || fs.readFileSync;
  let dir = normFile.slice(0, normFile.lastIndexOf('/'));
  state.inHook++; // 重入守卫：解析期间不记账（防递归产生噪声事件）
  try {
    for (let i = 0; i < 12 && dir && dir !== '/'; i++) {
      if (_pkgCache.has(dir)) return _pkgCache.get(dir);
      const pj = dir + '/package.json';
      try {
        if (rawExists(pj)) {
          const name = JSON.parse(rawRead(pj, 'utf8')).name || null;
          _pkgCache.set(dir, name);
          return name;
        }
      } catch { /* 容错 */ }
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
    return null;
  } finally {
    state.inHook--;
  }
}

function captureActor() {
  if (state.mode !== 'stack') {
    const store = als.getStore();
    if (store && store.actor) return store.actor;
    // 集成语义：插件入口全部 runAs 包裹 ⇒ 无上下文 = 宿主自身（发起者归因）
    if (state.mode === 'als') return 'host';
  }
  const holder = {};
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (_e, sites) => sites;
  Error.captureStackTrace(holder, captureActor);
  const sites = holder.stack;
  Error.prepareStackTrace = saved;
  for (const site of sites) {
    let cls = null;
    try { cls = classifyFile(site.getFileName && site.getFileName()); } catch { /* 帧不可读则跳过 */ }
    if (cls && cls !== 'skip') return cls;
  }
  return 'host';
}

// ---------- 事件记账 + 红线规则 ----------

const NET_API = /^https?:|^fetch|^net\.|^(http|https)\./;

/** 本机/保留地址不算"明文外联"（与静态体检卡同口径：dsh 自身就是 127.0.0.1） */
function isLocalTarget(t) {
  const host = (String(t).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:]/)[0] || '').toLowerCase();
  return !host || host === 'localhost' || /^127\./.test(host) || host === '0.0.0.0'
    || host === '::1' || host === '[::1]' || /\.(internal|local|localhost)$/.test(host);
}

function record(api, target, meta, actor) {
  const event = {
    t: Date.now(),
    actor: actor ?? safeActor(),
    api,
    target: String(target == null ? '' : target),
    flags: [],
    redLines: [],
    meta: meta || null,
  };
  // 自观测排除：防火墙自身的读写/扫描不得污染时间线，更不得形成 onEvent→append→record 反馈
  if (event.actor === 'self' || state.ignoreActors.has(event.actor)) return event;
  // 静默窗口内（产品自身发起的合法出网，如告警推送）不记账也不判红线
  if (state.silentDepth > 0) return event;
  const ts = event.target;
  // credentials-access 只算"碰到内容"的调用：stat/exists/readdir 之类只是元数据探询
  // （真机实测 chokidar 监听凭据文件目录，若也算就等于给监视器戴红线帽子，噪声化）
  const touchesContent = !/\.(stat|exists|lstat|access|readdir|watch|realpath)(Sync)?$/.test(api);
  if (touchesContent && /\.credentials\.yaml$|credentials\.yaml$|[\\/]\.dsh[\\/].*credential/i.test(ts)) event.flags.push('credentials-access');
  if (/^http:\/\//i.test(ts) && !isLocalTarget(ts)) event.flags.push('cleartext-http');
  if (api.startsWith('child_process')) event.flags.push('subprocess');

  state.totalEvents++;
  if (state.events.length < state.maxEvents) state.events.push(event);
  else state.droppedEvents++;

  // 调用内去重（真机实测）：红线曾以"复制一条事件再 emit"的方式投递，
  // 导致一次 fetch / http.request 在时间线里出现两条（t 完全相同、只差 redLine 字段），
  // 计数与 UI 都被放大。红线是事件的属性，不是新事件 —— 挂在同一事件的 redLines 上，只投递一次。
  evaluateRules(event);
  emit(event);
  return event;
}

/** 记一笔被拦截的行为（timeline 显示为 blocked，便于审计"拦了什么"） */
function recordBlocked(api, target, actor, decision) {
  const ev = {
    t: Date.now(),
    actor: actor ?? safeActor(),
    api,
    target: String(target == null ? '' : target),
    flags: ['blocked'],
    meta: { blocked: true, rule: decision.rule, reason: decision.reason, action: decision.action },
  };
  if (ev.actor === 'self' || state.ignoreActors.has(ev.actor)) return;
  state.totalEvents++;
  state.blockedCount++;
  if (state.events.length < state.maxEvents) state.events.push(ev);
  emit(ev);
}

/**
 * 事件投递：重入保护是硬要求——订阅者（尤其早期持久化）会做 fs I/O，
 * 而 fs 已被 hook；若不加保护就是 record → onEvent → write → record 的自反馈
 * （DSH_HOME 存在时实测把 37MB / 27 万条事件写进启动窗口）。
 */
function emit(event) {
  if (!state.onEvent || state.inEvent) return;
  state.inEvent = true;
  try { state.onEvent(event); } catch { /* 订阅者不得影响观测 */ }
  finally { state.inEvent = false; }
}

function safeActor() {
  try { return captureActor(); } catch { state.errors++; return 'unknown'; }
}

function evaluateRules(event) {
  // 宿主不是被审计对象：judge.observe 本就跳过 'host'，红线若还给宿主记，
  // 就会把"宿主读自己的凭据库 → 调 LLM API"这种固有行为标成 credentials+network
  // （真机实测每次会话必现），红线横幅被噪声淹没。标志位照记，红线不判。
  if (event.actor === 'host') return;
  const isNet = NET_API.test(event.api) || event.flags.includes('cleartext-http');
  const hasCred = event.flags.includes('credentials-access');
  const hasSub = event.flags.includes('subprocess');
  if (!isNet && !hasCred && !hasSub) return;
  const prior = state.events.slice(-state.ruleWindow).filter((e) => e.actor === event.actor && e !== event);
  const sawNet = () => prior.some((e) => NET_API.test(e.api) || e.flags.includes('cleartext-http'));
  const sawCred = () => prior.some((e) => e.flags.includes('credentials-access'));
  const sawSub = () => prior.some((e) => e.flags.includes('subprocess'));
  // 红线组合（方案 §1.1 口径：危险组合共现）
  if (hasCred && sawNet()) pushRedFlag('credentials+network', event);
  if (isNet && sawCred()) pushRedFlag('credentials+network', event);
  if (hasCred && sawSub()) pushRedFlag('credentials+subprocess', event);
  if (hasSub && sawCred()) pushRedFlag('credentials+subprocess', event);
  if (event.flags.includes('cleartext-http')) pushRedFlag('cleartext-http', event);
}

/**
 * 红线标注：把规则记到**同一个事件**上（调用内去重）。
 * 此前实现是 emit({...event, redLine: rule})——复制一条事件投递，一次 fetch 因此落两条。
 * 现在只写 event.redLines，并保留 redLine=首个规则（旧订阅者/JSONL 回放兼容）。
 */
function pushRedFlag(rule, event) {
  if (!Array.isArray(event.redLines)) event.redLines = [];
  if (event.redLines.includes(rule)) return;
  if (state.redFlags.some((f) => f.rule === rule && f.event === event)) {
    if (!event.redLines.includes(rule)) event.redLines.push(rule);
    return;
  }
  event.redLines.push(rule);
  if (!event.redLine) event.redLine = rule; // 兼容：单值字段 = 首条红线
  state.redFlags.push({ rule, t: event.t, actor: event.actor, event });
}

// ---------- hooks ----------

/** 预执行检查：调 beforeCall（含其状态跟踪），仅当决定 block 时返回决策 */
function preCheck(actor, api, target) {
  if (!state.beforeCall) return null;
  let d = null;
  try { d = state.beforeCall(actor, api, target); } catch { state.errors++; return null; } // fail-safe：引擎异常放行
  return d && d.action === 'block' ? d : null;
}

function wrap(obj, key, api, targetFn, opts) {
  let orig;
  try { orig = obj[key]; } catch { return; }
  if (typeof orig !== 'function') return;
  const o = opts || {};
  obj[key] = function (...args) {
    // 跨层去重：http.request/get 内部会调用 net.createConnection，
    // 一次逻辑调用会落两条（http.request + net.createConnection）。父调用已在
    // 事件里带上了目的地，嵌套的 socket 记录是重复，跳过记账（仍照常执行/预检）。
    const nestedInParent = o.nestedSkip && state.netParent > 0;
    const target = targetFn ? targetFn(args) : args[0];
    if (!nestedInParent) {
      const actor = safeActor();
      const decision = preCheck(actor, api, target);
      if (decision) {
        recordBlocked(api, target, actor, decision);
        throw new FirewallBlockError(decision.reason, { rule: decision.rule, api, target: String(target ?? '') });
      }
      try { record(api, target, null, actor); } catch { state.errors++; }
    }
    if (o.parent) state.netParent++;
    state.inHook++;
    try {
      return orig.apply(this, args);
    } finally {
      state.inHook--;
      if (o.parent) state.netParent--;
    }
  };
  obj[key].__orig = orig;
}

/**
 * 请求目标归一。defaultProto 必传：https.request({host}) 不带 protocol 字段，
 * 若一律默认 http: 就会把 https 目的地记成 http://（既误导用户，还会误判/漏判明文红线）。
 */
function normalizeReqTarget(opts, defaultProto) {
  const proto = defaultProto || 'http:';
  if (typeof opts === 'string') return opts;
  if (opts instanceof URL) return opts.href;
  if (opts && typeof opts === 'object') {
    const p = opts.protocol || proto;
    return p + '//' + (opts.hostname || opts.host || '') + (opts.path || '/');
  }
  return String(opts);
}

/**
 * net.connect/createConnection 的目标归一。
 *
 * 真机实测缺陷（不修就是漏报）：原实现 String(opts) 得到 "[object Object]"，
 * hostOf() 提不出 host → 目的地越界判定对整条 net 路径静默失效。
 *
 * 三种调用形态都要覆盖，否则攻击者换种写法就绕过：
 *   net.connect(80, 'host')            ← 位置参数，host 在 a[1]，最易漏
 *   net.connect({ host, port })
 *   net.connect('/tmp/sock') / { path } ← 命名管道，不是 TCP，不能标 tcp://
 */
function normalizeNetTarget(args) {
  const first = args[0];
  const second = args[1];

  // 命名管道（Windows \\.\pipe\x、POSIX unix socket 路径）：如实记为 pipe://，不假装 TCP
  const asPipe = (p) => 'pipe://' + String(p);
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return /[\\/]/.test(first) ? asPipe(first) : 'tcp://' + first;
  }

  if (typeof first === 'number') {
    const host = typeof second === 'string' && second ? second : 'localhost';
    return 'tcp://' + host + ':' + first;
  }

  if (first && typeof first === 'object') {
    if (Array.isArray(first)) return normalizeNetTarget(first);
    if (first.path) return asPipe(first.path);
    const host = first.host || first.hostname || 'localhost';
    return 'tcp://' + host + (first.port == null ? '' : ':' + first.port);
  }

  return String(first);
}

/** 早期持久化：boot 窗口的事件直接追加 JSONL（自排除防递归） */
function simpleAppend(file, e) {
  try {
    const fs = require('node:fs');
    const p = require('node:path');
    // 必须走原始函数：这是 onEvent 的落盘实现，再走被 hook 的 fs 会形成
    // record → onEvent → append → record 的自反馈递归（DSH_HOME 存在时必现）。
    const mkdir = fs.mkdirSync.__orig || fs.mkdirSync;
    const append = fs.appendFileSync.__orig || fs.appendFileSync;
    mkdir(p.dirname(file), { recursive: true });
    append(file, JSON.stringify(e) + '\n');
  } catch { state.errors++; }
}

/** 早期注册：枚举 node_modules 的每个包为插件（启动期 I/O 归因用） */
function registerProfilePlugins(nodeModulesDir) {
  const fs = require('node:fs');
  const p = require('node:path');
  try {
    for (const e of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(p.join(nodeModulesDir, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) registerPlugin(`${e.name}/${s.name}`, p.join(nodeModulesDir, e.name, s.name));
        }
      } else if (e.isDirectory()) {
        registerPlugin(e.name, p.join(nodeModulesDir, e.name));
      }
    }
  } catch { /* 容错 */ }
}

/** 从 loader baseUrl 推导 node_modules 并注册（earlyInstall 用） */
function registerProfilePluginsFromBase(baseUrl) {
  try {
    const { createRequire } = require('node:module');
    const p = require('node:path');
    const req2 = createRequire(baseUrl);
    const pkg = req2.resolve('dsh-pdr-plugin/package.json');
    registerProfilePlugins(p.dirname(p.dirname(pkg))); // .../node_modules
  } catch { /* 容错 */ }
}

/**
 * 插件入口 runAs 包裹 —— ALS 归因的真正落点。
 *
 * 背景（真机实测）：产品此前 `runAs` 只有定义、没有调用点，插件入口从未进入 ALS 上下文，
 * 真实归因全靠调用栈形状兜底。后果：栈归因贵（+141µs/op）、随打包形状漂移、
 * 异步回调丢上下文时退化成 host。
 *
 * 挂点：`RegistryService.prototype.plugin(plugin, config, getOuterStack)`
 * 是所有插件实例化的唯一收口（loader 的 Entry._init 最终也走它）。
 *
 * 怎么拿到 RegistryService（真机踩坑两次）：
 *   ① require.resolve('@deepseek-ai/cordis') → profile 里解析不到，MODULE_NOT_FOUND；
 *   ② 扫 require.cache → 预载时机太早，cordis 还没进 cache；
 *   ③ ✅ 从**已加载的插件自己的 ctx** 反推：`ctx.registry.constructor` 就是 RegistryService。
 *      这条最稳——插件能跑，说明 cordis 一定在，且拿到的必然是同一个类。
 */
function installRegistryHook(anyCtx) {
  if (state.registryHooked) return true;
  try {
    const Registry = resolveRegistryCtor(anyCtx);
    if (!Registry) return false;
    return hookRegistryClass(Registry);
  } catch {
    return false;
  }
}

/**
 * 预载期陷阱：cordis 一被 require 就立刻把 RegistryService 挂钩。
 *
 * 为什么必需（真机实证）：profile 的 bundles 顺序里 pdr-probe-diag 排在
 * dsh-pdr-plugin **前面**，等我们插件入口跑 installRegistryHook 时，
 * diag 已经实例化完、整段 I/O 已经记成 'host' 了。用户不可能被要求改
 * bundles 顺序，所以 hook 必须早于**任何**插件实例化——预载是唯一时机。
 * 实测：挂钩过晚时 registry 有 132 条而只有 63 条经过 hook，69 个插件不可归因。
 *
 * 两条路线见函数体。任何异常都吞掉，绝不影响宿主加载；
 * 都失败时还有插件入口的 installRegistryHook 兜底（归因会少一批，但不会坏）。
 */
function installRegistryHookEarly() {
  if (state.registryHooked || state.registryEarlyTried) return state.registryHooked;
  state.registryEarlyTried = true;
  /**
   * 路线①（主力）：cordis 是纯 ESM（"type":"module"），`Module._load` 拦不到它，
   * 因为宿主的插件加载器走的是原生 `import`。但 Node 22+ 支持 `require(esm)`，
   * 且真机实测 **require 与 import 返回同一个模块实例**（同一对象、同一原型）。
   * 所以预载期直接用宿主的 argv[1] 建一个 createRequire 把 cordis require 进来、
   * 立刻 patch 原型，宿主之后 `import` 到的就是已经打过补丁的那一份。
   * ——这是唯一能早于**所有**插件实例化的时机。
   */
  try {
    const Module = require('node:module');
    const entry = process.argv[1];
    if (entry) {
      const req = Module.createRequire(entry);
      for (const spec of ['@deepseek-ai/cordis', '@deepseek-ai/cordis/lib/index.js']) {
        try {
          const ns = req(spec);
          const R = ns && (ns.RegistryService || ns.Registry);
          if (R && R.prototype && typeof R.prototype.plugin === 'function') {
            if (hookRegistryClass(R)) return true;
          }
        } catch { /* 试下一个 spec */ }
      }
    }
  } catch { /* 落回路线② */ }

  // 路线②（兜底）：CJS 宿主会走 Module._load，拦截它作为保险
  try {
    const Module = require('node:module');
    const origLoad = Module._load;
    if (origLoad && origLoad.__pdrEarly) return state.registryHooked;
    Module._load = function (request, parent, isMain) {
      const out = origLoad.apply(this, arguments);
      if (state.registryHooked) return out;
      try {
        if (out && (typeof out === 'object' || typeof out === 'function')) {
          const R = out.RegistryService
            || (out.default && out.default.RegistryService);
          if (R && R.prototype && typeof R.prototype.plugin === 'function') hookRegistryClass(R);
        }
      } catch { /* 挂不上就退回插件入口那条路 */ }
      return out;
    };
    Module._load.__pdrEarly = true;
    Module._load.__pdrOrig = origLoad;
    return state.registryHooked;
  } catch {
    state.errors++;
    return false;
  }
}

/**
 * 从 plugin 对象本身反推"这是哪个插件"。
 * 真机实测两次教训：
 *   ① 在 `RegistryService.plugin()` 被调用的时刻抓调用栈是**没用的**——
 *      那时栈是 loader 的 `Entry._init`，看不到插件源码帧，只会全部落空。
 *   ② 正确的信息源是 plugin 对象自己：apply/默认导出函数的 **源码位置**。
 *      用 `Function.prototype.toString` 拿不到路径，但 cordis 的 plugin 通常带
 *      `inject`/`Config`；更可靠的是遍历 require.cache，找 exports 里含这个函数的模块。
 * 这里按"最可能命中"的顺序试，全部失败返回 null。
 */
function actorFromPluginObject(plugin) {
  try {
    const fns = [];
    /**
     * 只收**自有** apply：class 与普通函数没有自己的 'apply'，
     * `plugin.apply` 会取到 Function.prototype.apply（所有函数共享同一个引用）。
     * 一旦把它收进 fns，下面遍历 require.cache 时任何导出函数的模块都会
     * `exp.apply === Function.prototype.apply` 而伪命中——真机实测把
     * LocalSubprocessRuntime/AgentLoop/ToolRegistry 等几十个 class 插件
     * 全部错归成第一个被遍历到的包（semver）。
     */
    if (typeof plugin === 'function') fns.push(plugin);
    else if (plugin && typeof plugin.apply === 'function') fns.push(plugin.apply);
    if (!fns.length) return null;
    const bogus = Function.prototype.apply;
    const usable = (f) => typeof f === 'function' && f !== bogus && fns.includes(f);

    // 1) 遍历 require.cache：哪个模块的导出里含有这个函数 → 读它的 package.json
    const cache = require.cache || {};
    for (const [file, mod] of Object.entries(cache)) {
      const exp = mod && mod.exports;
      if (!exp) continue;
      let hit = false;
      try {
        if (usable(exp)) hit = true;
        else if (exp.default && usable(exp.default)) hit = true;
        else if (usable(exp.apply)) hit = true;
        else {
          for (const v of Object.values(exp)) {
            if (usable(v)) { hit = true; break; }
            if (v && typeof v === 'object' && usable(v.apply)) { hit = true; break; }
          }
        }
      } catch { continue; }
      if (!hit) continue;
      const norm = file.replace(/\\/g, '/');
      const name = packageForFile(norm);
      if (name && name !== SELF_PKG) return name;
      break;
    }

    /**
     * 2) ESM 插件不在 require.cache 里（真机实测：pdr-probe-diag 为 type:module，
     *    也拿不到 require，这条路径对它完全无效）。退而用**源码指纹**：
     *    把 profile 目录下所有插件的源码读进来，找哪份源码里含有这段函数体的
     *    特征文本。范围限死在 profile/node_modules，代价是每次未命中要读一批
     *    文件——所以结果缓存，且只在 require.cache 落空时才走。
     */
    const fp = actorFromFingerprint(fns);
    if (fp) return fp;

    // 2) 退一步：用闭包外的 file 线索（部分插件会给 apply 挂 loadedFrom 之类的元数据）
    for (const fn of fns) {
      const meta = fn.__loadedFrom || fn.loadedFrom || fn.modulePath;
      if (typeof meta === 'string') {
        const name = packageForFile(meta.replace(/\\/g, '/'));
        if (name && name !== SELF_PKG) return name;
      }
    }
  } catch { /* 反推失败不影响主流程 */ }
  return null;
}

/**
 * ESM 插件的最后一条反推路径：源码指纹。
 *
 * 为什么需要：ESM 模块不进 require.cache（diag 插件里 `require` 直接未定义），
 * 上面那条"遍历缓存找导出"对它必然落空；而匿名 object 插件连 `name` 都没有，
 * 于是整段插件 I/O 只能归 'host'——用户看到的是"插件在动，但不知道是谁"。
 *
 * 做法：取函数源码做特征串，在 profile/node_modules 里找哪份源码含它。
 * 性能约束（真机有几十个匿名插件，每个都独立 token 串，不能每个都全盘扫）：
 *   ① 语料**只建一次**并常驻，所有匿名插件共用，单次遍历而不是 N 次；
 *   ② 只扫 profile 下的插件目录，单文件 >512KB 或总语料 >32MB 即停止扩容；
 *   ③ 特征串去注释去空白取前 200 字符，够独特又不至于被格式化差异打散；
 *   ④ 负结果也缓存，同一函数不会重复搜。
 */
const fingerprintCache = new Map();
let fingerprintCorpus = null;

/**
 * 源码归一化：去注释 + 折叠空白。
 *
 * **两侧必须用同一个函数**。真机踩过：needle 侧去了注释、语料侧没去，
 * 于是函数体里只要有一行 `// 说明`，needle 就跨过了注释内容而语料里还留着，
 * 导致"有注释的插件永远匹配不上"——表现为这些插件全部退化成函数名（如
 * `victimPlugin`）而不是包名，甚至直接归 host。
 */
function normalizeSource(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ');
}

function buildFingerprintCorpus() {
  const out = [];
  const budget = { bytes: 0, max: 32 * 1024 * 1024, files: 0, maxFiles: 4000 };
  const walk = (dir) => {
    let entries;
    try { entries = require('node:fs').readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (budget.bytes >= budget.max || budget.files >= budget.maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.') || ent.name === 'test' || ent.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!/\.(?:c|m)?js$/.test(ent.name)) continue;
      try {
        const st = require('node:fs').statSync(full);
        if (st.size > 512 * 1024) continue;
        const text = require('node:fs').readFileSync(full, 'utf8');
        budget.bytes += text.length;
        budget.files++;
        out.push({ file: full.replace(/\\/g, '/'), text: normalizeSource(text) });
      } catch { /* 单文件失败继续 */ }
    }
  };
  for (const root of state.fingerprintRoots) {
    // 根目录本身可能是 test/fixtures 这类被 walk 跳过的名字，必须直接走
    walk(root);
  }
  return out;
}

function actorFromFingerprint(fns) {
  try {
    if (!state.fingerprintRoots.length) return null;
    for (const fn of fns) {
      let src = '';
      try { src = Function.prototype.toString.call(fn); } catch { continue; }
      const flat = normalizeSource(src).trim();
      if (flat.length < 40) continue; // 太短（如 `function anonymous`）没有辨识度
      if (fingerprintCache.has(flat)) {
        const hit = fingerprintCache.get(flat);
        if (hit) return hit;
        continue;
      }
      if (!fingerprintCorpus) fingerprintCorpus = buildFingerprintCorpus();
      // 取中段而不是开头：开头常是 `function name(` / 方法简写，跨文件写法差异大；
      // 函数体中段（含具体调用与字符串字面量）辨识度最高。
      const needle = flat.length > 260 ? flat.slice(40, 240) : flat.slice(0, 200);
      let found = null;
      for (const item of fingerprintCorpus) {
        if (!item.text.includes(needle)) continue;
        const name = packageForFile(item.file);
        if (name && name !== SELF_PKG) { found = name; break; }
      }
      fingerprintCache.set(flat, found);
      if (found) return found;
    }
  } catch { /* 指纹匹配失败不影响主流程 */ }
  return null;
}

/** 从各种可能的入口拿到 RegistryService 类 */
function resolveRegistryCtor(anyCtx) {
  // 1) 显式传入的 ctx（插件入口里最可靠）
  try {
    const reg = anyCtx && anyCtx.registry;
    if (reg && reg.constructor && reg.constructor.prototype && typeof reg.constructor.prototype.plugin === 'function') {
      return reg.constructor;
    }
  } catch { /* 下一个 */ }
  // 2) require.cache 里的 cordis（宿主已加载时可用）
  try {
    const cache = require.cache || {};
    for (const [file, mod] of Object.entries(cache)) {
      if (!/[\\/]@deepseek-ai[\\/]cordis[\\/]/.test(file)) continue;
      const exp = mod && mod.exports;
      const R = exp && (exp.RegistryService || exp.Registry || (exp.default && exp.default.RegistryService));
      if (R && R.prototype && typeof R.prototype.plugin === 'function') return R;
    }
  } catch { /* 下一个 */ }
  return null;
}

/** 真正的打补丁逻辑（接受类），独立出来便于测试 */
function hookRegistryClass(Registry) {
  if (state.registryHooked) return true;
  try {
    const proto = Registry && Registry.prototype;
    if (!proto || typeof proto.plugin !== 'function') return false;
    if (proto.plugin.__pdrHooked) { state.registryHooked = true; return true; }

    const orig = proto.plugin;
    proto.plugin = function (plugin, config, getOuterStack) {
      let actor = null;
      let rec = null;
      try {
        /**
         * 名字来源优先级（真机实测校准过）：
         *   ① 已注册的插件目录映射（packageForFile 的权威结果，最一致）
         *   ② 导出名（plugin.name / apply.name）
         *   ③ 调用栈反推包名
         * 为什么要①优先：同一个插件可能导出 "dsh-rewind"（包内自取名），
         * 而 step ③ 从路径反推得到 "dsh-rewind-plugin"（真实包名），
         * 两者不一致会让时间线里同一个插件裂成两条，统计全乱。
         */
        actor = actorFromPluginObject(plugin); // 先试权威包名（plugin 对象 → require.cache → package.json）
        if (!actor) {
          actor = (plugin && (plugin.name || (plugin.apply && plugin.apply.name))) || null;
          if (actor === 'apply' || actor === '' || actor === 'anonymous' || actor === 'default') actor = null;
        }
        if (state.registrations.length < 200) {
          try {
            rec = {
              t: Date.now(),
              actor: actor || null,
              type: typeof plugin,
              name: (plugin && plugin.name) || null,
              applyName: (plugin && plugin.apply && plugin.apply.name) || null,
              isDefault: !!(plugin && plugin.default),
              defaultType: plugin && plugin.default ? typeof plugin.default : null,
              defaultName: (plugin && plugin.default && plugin.default.name) || null,
              keys: plugin && typeof plugin === 'object' ? Object.keys(plugin).slice(0, 12) : null,
              src: (() => {
                try {
                  const f = typeof plugin === 'function' ? plugin : (plugin && plugin.apply);
                  return f ? Function.prototype.toString.call(f).replace(/\s+/g, ' ').slice(0, 110) : null;
                } catch { return null; }
              })(),
            };
            state.registrations.push(rec);
          } catch { /* 诊断自身不许出错 */ }
        }
        /**
         * 定不出是哪个插件时的归属：loader 在实例化过程中自己也会读配置/探路径，
         * 这些 I/O 发生在插件代码之外，本质是宿主基础设施行为。
         * 归 'host' 比归 'unknown-plugin' 诚实——后者会让时间线凭空多出一个"未知插件"，
         * 用户会以为有个来路不明的东西在活动（真机实测 77 条，全是 loader 自己的文件访问）。
         */
        if (!actor) return orig.call(this, plugin, config, getOuterStack);
        if (state.ignoreActors.has(actor)) return orig.call(this, plugin, config, getOuterStack);
      } catch { return orig.call(this, plugin, config, getOuterStack); }

      let wrapped = plugin;
      let wrapKind = 'none';
      try {
        const isClass = typeof plugin === 'function'
          && /^class\s/.test(Function.prototype.toString.call(plugin));
        if (isClass) {
          // 构造器不包：`new X()` 语义不能被普通函数破坏（cordis 插件通常是 apply 函数，这类少见）
          wrapKind = 'class-skip';
          wrapped = plugin;
        } else if (typeof plugin === 'function') {
          if (plugin.__pdrWrapped) { wrapKind = 'already'; return orig.call(this, plugin, config, getOuterStack); }
          const fn = function (...args) { return als.run({ actor }, () => plugin.apply(this, args)); };
          /**
           * 注意：**不能**写 `fn.name = plugin.name`。本文件是 'use strict'，
           * 而函数对象的 name 属性 writable:false / configurable:true，
           * 严格模式下直接赋值会抛 TypeError，被下面的 catch 吞掉后
           * 整个插件就静默地不被包装——真机实测 31 个函数式插件（含 pdr-probe-diag、
           * session-persistence-jsonl、agent-instructions…）全栽在这一行上，
           * 表现为"registry 里有它、事件全记成 host"。必须用 defineProperty。
           */
          try { Object.defineProperty(fn, 'name', { value: plugin.name, configurable: true }); } catch { /* 改名失败不影响包装 */ }
          fn.inject = plugin.inject;
          fn.Config = plugin.Config;
          fn.__pdrWrapped = true;
          fn.__pdrOrig = plugin;
          wrapped = fn;
          wrapKind = 'fn';
        } else if (plugin && typeof plugin.apply === 'function') {
          if (plugin.__pdrWrapped) { wrapKind = 'already'; return orig.call(this, plugin, config, getOuterStack); }
          const origApply = plugin.apply;
          wrapped = Object.create(plugin);
          wrapped.apply = function (ctx, cfg) { return als.run({ actor }, () => origApply.call(this, ctx, cfg)); };
          wrapped.inject = plugin.inject;
          wrapped.Config = plugin.Config;
          wrapped.__pdrWrapped = true;
          wrapped.__pdrOrig = plugin;
          wrapKind = 'obj';
        }
        if (rec) rec.wrapKind = wrapKind;
      } catch (e) {
        state.errors++;
        if (rec) rec.wrapErr = String(e && e.message).slice(0, 140);
        wrapped = plugin; // 包失败就原样放过，绝不让宿主起不来
      }
      return orig.call(this, wrapped, config, getOuterStack);
    };
    proto.plugin.__pdrHooked = true;
    proto.plugin.__pdrOrig = orig;
    state.registryHooked = true;
    // 记录挂钩时机：此刻已经发生过多少次 plugin() 注册。>0 说明有插件在我们之前
    // 就实例化完了，那批插件的 I/O 已经不可归因（只能算 host）——这是诊断关键指标。
    try { if (state.hookOrder < 0) state.hookOrder = state.registrations.length; } catch { /* 忽略 */ }
    return true;
  } catch {
    state.errors++;
    return false;
  }
}


/**
 * 早期启动（earlyInstall 调用）：装探针 + 早期注册 + 早期持久化。
 * 封装在这里，让 !!js 表达式保持单行无 `:`/`?`（YAML 安全）。
 */
function boot(baseUrl, mode) {
  // 模式优先级：显式入参 > 环境变量 > state 默认（'als'）
  install({ mode: mode || process.env.PDR_PROBE_MODE || state.mode });
  try { registerProfilePluginsFromBase(baseUrl); } catch { state.errors++; }
  /**
   * 预载期就尝试挂钩：cordis 一被 require/import 立刻包住 RegistryService，
   * 保证 hook 早于**所有**插件实例化（profile 的 bundles 顺序我们改不了，
   * 真机上 pdr-probe-diag 排在 dsh-pdr-plugin 前面，晚挂就等于它全程不可归因）。
   * 拿不到也没关系，插件入口的 installRegistryHook 仍是兜底。
   */
  try { installRegistryHookEarly(); } catch { state.errors++; }
  // 预载阶段拿不到 cordis（还没加载），真正的挂在插件入口用 ctx 反推（见 installRegistryHook）
  try {
    const home = process.env.DSH_HOME;
    if (home && !state.onEvent) {
      state.persistFile = require('node:path').join(home, 'firewall', 'events.jsonl');
      state.onEvent = (e) => simpleAppend(state.persistFile, e);
    }
  } catch { state.errors++; }
  // 调试：记录注册结果（真机归因诊断用，稳定后可删）
  try {
    const home = process.env.DSH_HOME;
    if (home) {
      const fs = require('node:fs');
      const p = require('node:path');
      const dir = p.join(home, 'firewall');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p.join(dir, 'boot-debug.json'), JSON.stringify({
        registered: [...state.plugins.entries()],
        selfRoot: SELF_ROOT,
        baseUrl: String(baseUrl),
        mode: state.mode,
        registryHooked: state.registryHooked,
        hookOrder: state.hookOrder,
        registrationsSoFar: state.registrations.length,
        cordisInCache: Object.keys(require.cache || {}).filter((f) => /cordis/.test(f)).length,
        argv1: String(process.argv[1] || ''),
        execPath: process.execPath,
        mainModule: (require.main && require.main.filename) || null,
      }, null, 2));
    }
  } catch { /* 调试失败忽略 */ }
  return state.installed;
}

function install(options) {
  if (state.installed) return true;
  try {
    const opts = options || {};
    if (opts.mode) state.mode = opts.mode;
    if (opts.maxEvents) state.maxEvents = opts.maxEvents;
    if (opts.ruleWindow) state.ruleWindow = opts.ruleWindow;
    if (opts.onEvent) state.onEvent = opts.onEvent;

    const fs = require('node:fs');
    const fsp = require('node:fs/promises');
    const cp = require('node:child_process');
    const http = require('node:http');
    const https = require('node:https');
    const net = require('node:net');
    const tls = require('node:tls');

    wrap(fs, 'readFileSync', 'fs.readFileSync');
    wrap(fs, 'readFile', 'fs.readFile');
    wrap(fs, 'writeFileSync', 'fs.writeFileSync');
    wrap(fs, 'writeFile', 'fs.writeFile');
    wrap(fs, 'openSync', 'fs.openSync');
    wrap(fs, 'open', 'fs.open');
    wrap(fs, 'appendFileSync', 'fs.appendFileSync');
    wrap(fs, 'copyFileSync', 'fs.copyFileSync');
    wrap(fs, 'unlinkSync', 'fs.unlinkSync');
    wrap(fs, 'rmSync', 'fs.rmSync');
    wrap(fs, 'readdirSync', 'fs.readdirSync');
    wrap(fs, 'mkdirSync', 'fs.mkdirSync');
    wrap(fs, 'rmdirSync', 'fs.rmdirSync');
    wrap(fs, 'statSync', 'fs.statSync');
    wrap(fs, 'renameSync', 'fs.renameSync');
    wrap(fs, 'existsSync', 'fs.existsSync');
    // fs/promises 全量（真实插件回归教训：SnapshotStore 直接用 mkdir/stat/copyFile/unlink，
    // 只 wrap 四个方法会整类漏报）
    wrap(fsp, 'readFile', 'fs.promises.readFile');
    wrap(fsp, 'writeFile', 'fs.promises.writeFile');
    wrap(fsp, 'appendFile', 'fs.promises.appendFile');
    wrap(fsp, 'open', 'fs.promises.open');
    wrap(fsp, 'rm', 'fs.promises.rm');
    wrap(fsp, 'mkdir', 'fs.promises.mkdir');
    wrap(fsp, 'rmdir', 'fs.promises.rmdir');
    wrap(fsp, 'readdir', 'fs.promises.readdir');
    wrap(fsp, 'stat', 'fs.promises.stat');
    wrap(fsp, 'lstat', 'fs.promises.lstat');
    wrap(fsp, 'copyFile', 'fs.promises.copyFile');
    wrap(fsp, 'unlink', 'fs.promises.unlink');
    wrap(fsp, 'rename', 'fs.promises.rename');
    wrap(fsp, 'access', 'fs.promises.access');
    wrap(fsp, 'cp', 'fs.promises.cp');
    wrap(cp, 'spawn', 'child_process.spawn', (a) => String(a[0] || '') + ' ' + (Array.isArray(a[1]) ? a[1].join(' ') : ''));
    wrap(cp, 'spawnSync', 'child_process.spawnSync', (a) => String(a[0] || '') + ' ' + (Array.isArray(a[1]) ? a[1].join(' ') : ''));
    wrap(cp, 'exec', 'child_process.exec', (a) => String(a[0] || '').slice(0, 200));
    wrap(cp, 'execSync', 'child_process.execSync', (a) => String(a[0] || '').slice(0, 200));
    wrap(cp, 'execFile', 'child_process.execFile', (a) => String(a[0] || ''));
    wrap(cp, 'execFileSync', 'child_process.execFileSync', (a) => String(a[0] || ''));
    wrap(http, 'request', 'http.request', (a) => normalizeReqTarget(a[0], 'http:'), { parent: true });
    wrap(http, 'get', 'http.get', (a) => normalizeReqTarget(a[0], 'http:'), { parent: true });
    wrap(https, 'request', 'https.request', (a) => normalizeReqTarget(a[0], 'https:'), { parent: true });
    wrap(https, 'get', 'https.get', (a) => normalizeReqTarget(a[0], 'https:'), { parent: true });
    wrap(net, 'connect', 'net.connect', (a) => normalizeNetTarget(a), { nestedSkip: true });
    wrap(net, 'createConnection', 'net.createConnection', (a) => normalizeNetTarget(a), { nestedSkip: true });
    // https.request 走 tls.connect（真机实测：不补这条，https 目的地记不下来）
    wrap(tls, 'connect', 'tls.connect', (a) => normalizeNetTarget(a), { nestedSkip: true });

    const origFetch = globalThis.fetch;
    if (typeof origFetch === 'function') {
      globalThis.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const actor = safeActor();
        const decision = preCheck(actor, 'fetch', url);
        if (decision) {
          recordBlocked('fetch', url, actor, decision);
          throw new FirewallBlockError(decision.reason, { rule: decision.rule, api: 'fetch', target: String(url ?? '') });
        }
        try {
          record('fetch', url, { method: (init && init.method) || 'GET' }, actor);
        } catch { state.errors++; }
        // fetch 底层同步走 net.connect/tls.connect（真机实测），记为父调用，
        // 让嵌套的 socket 层不再重复记账——否则一次 fetch 落两条。
        state.netParent++;
        try {
          return origFetch.apply(this, arguments);
        } finally {
          state.netParent--;
        }
      };
      globalThis.fetch.__orig = origFetch;
    }

    // ★ 第二层：binding 层深 patch（M1 实证）——ESM 具名导入在 facade 创建时固化函数值，
    // 属性 patch 只覆盖 default/require 消费方式；patch 内部 binding 可截获**所有**消费方式
    // （原始函数内部也走 binding）。process.binding 已废弃，逐个 try/catch，失败自动降级。
    try {
      const binding = process.binding('fs');
      const origRead = binding.readFileUtf8;
      if (typeof origRead === 'function') {
        binding.readFileUtf8 = function (p) {
          // inHook：属性层已检查/记账的调用跳过（双层去重）；否则兜底检查+拦截
          if (!state.inHook) {
            const actor = safeActor();
            const decision = preCheck(actor, 'fs.readFileUtf8', p);
            if (decision) {
              recordBlocked('fs.readFileUtf8', p, actor, decision);
              throw new FirewallBlockError(decision.reason, { rule: decision.rule, api: 'fs.readFileUtf8', target: String(p ?? '') });
            }
            try { record('fs.readFileUtf8', p, null, actor); } catch { state.errors++; }
          }
          return origRead.apply(this, arguments);
        };
      }
      const origOpen = binding.open;
      if (typeof origOpen === 'function') {
        binding.open = function (p) {
          if (!state.inHook) {
            const actor = safeActor();
            const decision = preCheck(actor, 'fs.binding.open', p);
            if (decision) {
              recordBlocked('fs.binding.open', p, actor, decision);
              throw new FirewallBlockError(decision.reason, { rule: decision.rule, api: 'fs.binding.open', target: String(p ?? '') });
            }
            try { record('fs.binding.open', p, null, actor); } catch { state.errors++; }
          }
          const fd = origOpen.apply(this, arguments);
          try { if (typeof fd === 'number') state.fdPaths.set(fd, String(p)); } catch {}
          return fd;
        };
      }
      // 写路径深 patch（真机实测：ESM facade 快照使 property 层失效，write 必须走 binding 兜底）
      for (const wname of ['writeFileUtf8', 'writeBuffer', 'writeString', 'writeBuffers']) {
        const origW = binding[wname];
        if (typeof origW !== 'function') continue;
        binding[wname] = function (fdOrPath) {
          if (!state.inHook) {
            const actor = safeActor();
            // 直接记录原始参数（fd 数字或路径）。fd→路径反查会因 fd 复用误配，暂不用。
            const target = String(fdOrPath ?? '');
            const decision = preCheck(actor, 'fs.binding.' + wname, target);
            if (decision) {
              recordBlocked('fs.binding.' + wname, target, actor, decision);
              throw new FirewallBlockError(decision.reason, { rule: decision.rule, api: 'fs.binding.' + wname, target });
            }
            try { record('fs.binding.' + wname, target, null, actor); } catch { state.errors++; }
          }
          return origW.apply(this, arguments);
        };
      }
    } catch { state.errors++; }

    // ★ 第三层：插件入口 runAs 包裹（ALS 归因的真正落点）
    // 前两层只解决"看到 I/O"，这一层解决"知道是谁"。没有它，插件入口不在 ALS 上下文里，
    // 归因只能靠调用栈形状猜（脆弱且贵：栈归因 +141µs/op）。
    // 挂点：cordis 的 RegistryService.prototype.plugin —— 所有插件实例化的唯一入口。
    installRegistryHook();

    state.installed = true;
    return true;
  } catch (error) {
    state.errors++;
    state.installed = false;
    return false; // fail-safe：安装失败不抛出
  }
}

// ---------- 查询面 ----------

function getEvents(filter) {
  const f = filter || {};
  return state.events.filter((e) =>
    (!f.actor || e.actor === f.actor) &&
    (!f.flag || e.flags.includes(f.flag) ||
      (f.flag === 'redline' && (e.redLine || (e.redLines && e.redLines.length)))) &&
    (!f.since || e.t >= f.since) &&
    (!f.until || e.t <= f.until) &&
    (!f.api || e.api.startsWith(f.api))
  ).slice(-(f.limit || 200));
}

function getRedFlags() {
  return state.redFlags.map(({ rule, t, actor, event }) => ({ rule, t, actor, target: event.target, api: event.api }));
}

function getSummary() {
  const byActor = new Map();
  for (const e of state.events) {
    const row = byActor.get(e.actor) || { actor: e.actor, total: 0, network: 0, fs: 0, subprocess: 0, credentials: 0 };
    row.total++;
    if (NET_API.test(e.api)) row.network++;
    else if (e.api.startsWith('child_process')) row.subprocess++;
    else row.fs++;
    if (e.flags.includes('credentials-access')) row.credentials++;
    byActor.set(e.actor, row);
  }
  return { actors: [...byActor.values()], redFlags: getRedFlags(), stats: getStats() };
}

function getStats() {
  return {
    installed: state.installed,
    mode: state.mode,
    totalEvents: state.totalEvents,
    stored: state.events.length,
    dropped: state.droppedEvents,
    blocked: state.blockedCount,
    errors: state.errors,
    registeredPlugins: [...state.plugins.values()],
    registryHooked: state.registryHooked,
    hookOrder: state.hookOrder,
  };
}

function reset() {
  state.events = [];
  state.redFlags = [];
  state.totalEvents = 0;
  state.droppedEvents = 0;
  state.blockedCount = 0;
}

/** 安装后补配（earlyInstall 先装、插件入口后补 onEvent 的场景） */
function configure(opts) {
  const o = opts || {};
  if (o.mode) state.mode = o.mode;
  if (o.maxEvents) state.maxEvents = o.maxEvents;
  if (o.ruleWindow) state.ruleWindow = o.ruleWindow;
  if (o.onEvent) state.onEvent = o.onEvent;
  if ('beforeCall' in o) state.beforeCall = o.beforeCall || null;
}

module.exports = {
  install,
  boot,
  configure,
  isInstalled: () => state.installed,
  registerPlugin,
  addIgnoredActor,
  addIgnoredDir,
  runAs,
  silent, // 产品自身合法出网（告警推送）不污染时间线
  installRegistryHook,
  installRegistryHookEarly, // 预载期拦截 Module._load，cordis 一加载就挂钩
  hookRegistryClass, // 测试用：直接传入 RegistryService 类
  isRegistryHooked: () => state.registryHooked,
  getRegistrations: () => state.registrations.slice(), // 诊断：plugin() 入参形态
  setMode: (m) => { state.mode = m; },
  getEvents,
  getRedFlags,
  getSummary,
  getStats,
  reset,
  FirewallBlockError,
};
globalThis[SINGLETON_KEY] = module.exports;
}
