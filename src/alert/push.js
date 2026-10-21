/**
 * 告警推送 —— 方案 §4.1④ / M3「企业特性」之告警推送
 *
 * 产品原则冲突必须先讲清：方案 §5.4 说"本地优先、不上传任何遥测"。
 * 告警推送天然是**把数据发出去**，所以它必须是：
 *   ① **默认关闭**——不开就永远不会有一个字节离开本机；
 *   ② **由用户显式配置**目标地址（webhook），不是我们预设的后端；
 *   ③ **只发红线事件**，不发全量时间线、不发文件内容、不发凭据。
 * 这三条是"本地优先"与"企业告警"之间的边界，写死在实现里，不做成开关。
 *
 * 工程约束（真机教训）：
 *   - **必须静默**：推送走被 hook 的 fetch/https，不静默就会自己给自己记账，
 *     甚至因为目标是 http:// 而触发 cleartext-http 红线 → record→推送→record 自激；
 *   - **必须限流去重**：一次外联常连发多条红线，逐条推送会把 webhook 打爆；
 *   - **必须 fail-safe**：推送失败绝不能影响宿主或观测（方案 §6.3）。
 */

const DEFAULTS = {
  enabled: false,
  url: '',
  /** 只推送这些规则；空数组 = 全部红线 */
  rules: [],
  /** 同 (actor, rule, target) 在该窗口内只推一次 */
  dedupeWindowMs: 60_000,
  /** 每分钟最多推送条数（跨规则总量） */
  maxPerMinute: 20,
  timeoutMs: 5_000,
  /** 推送格式：'json'（默认，自定义 webhook）| 'slack' | 'dingtalk' */
  format: 'json',
};

/** 简单的滑动窗口限流 + 指纹去重（内存态，进程退出即清） */
function createThrottle({ dedupeWindowMs, maxPerMinute }, now = () => Date.now()) {
  const seen = new Map(); // fingerprint -> lastSentAt
  let windowStart = 0;
  let inWindow = 0;

  return {
    /** 返回 true 表示允许发送 */
    allow(fp) {
      const t = now();
      const last = seen.get(fp);
      if (last !== undefined && t - last < dedupeWindowMs) return false;
      if (t - windowStart >= 60_000) { windowStart = t; inWindow = 0; }
      if (inWindow >= maxPerMinute) return false;
      seen.set(fp, t);
      inWindow++;
      // 顺手清理过期指纹，避免长跑进程内存增长
      if (seen.size > 1000) {
        for (const [k, ts] of seen) if (t - ts >= dedupeWindowMs) seen.delete(k);
      }
      return true;
    },
    get size() { return seen.size; },
  };
}

/** 各家的 payload 形状不同，转换集中在这里，避免调用方各自拼 */
export function buildPayload(flag, format) {
  const text = `[DSH-PDR] ${flag.actor} 触发红线 ${flag.rule}`
    + (flag.target ? ` → ${flag.target}` : '')
    + (flag.api ? ` (${flag.api})` : '');
  if (format === 'slack') return { text };
  if (format === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  return {
    source: 'dsh-pdr-plugin',
    type: 'red-flag',
    sentAt: new Date().toISOString(),
    flag: {
      rule: flag.rule,
      actor: flag.actor,
      t: flag.t,
      api: flag.api ?? null,
      target: flag.target ?? null,
    },
    text,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.config  用户配置（见 DEFAULTS）
 * @param {Function} opts.silent 探针的静默执行器（必须传，否则会自激）
 * @param {Function} [opts.fetchImpl] 便于测试注入
 * @param {Function} [opts.now]
 * @returns {{ push: Function, stats: Function, update: Function }}
 */
export function createAlertPusher({ config = {}, silent, fetchImpl, now = () => Date.now() }) {
  const cfg = { ...DEFAULTS, ...config };
  const throttle = createThrottle(cfg, now);
  const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

  let sent = 0;
  let deduped = 0;
  let failed = 0;
  let lastError = null;

  /**
   * 推送一条红线。**永远不抛**：任何失败都只记 stats。
   * 返回 {ok, skipped?} 便于测试断言，生产调用方可忽略。
   */
  function push(flag) {
    try {
      if (!cfg.enabled || !cfg.url || !doFetch) return { ok: false, skipped: 'disabled' };
      if (!flag || !flag.rule) return { ok: false, skipped: 'no-rule' };
      if (Array.isArray(cfg.rules) && cfg.rules.length && !cfg.rules.includes(flag.rule)) {
        return { ok: false, skipped: 'rule-filtered' };
      }
      const fp = `${flag.actor}\u0000${flag.rule}\u0000${flag.target ?? ''}`;
      if (!throttle.allow(fp)) {
        deduped++;
        return { ok: false, skipped: 'throttled' };
      }

      const body = JSON.stringify(buildPayload(flag, cfg.format));
      const run = () => doFetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(cfg.timeoutMs)
          : undefined,
      });

      // 关键：静默执行，否则这次 fetch 会被自己记成一条事件（还可能是 cleartext-http）
      const p = typeof silent === 'function' ? silent(run) : run();
      // 失败只统计，不冒泡；用 catch 而不是 await，避免把推送变成同步阻塞
      Promise.resolve(p).then(
        (res) => { if (res && res.ok === false) { failed++; lastError = `http ${res.status}`; } else { sent++; } },
        (e) => { failed++; lastError = String(e && e.message).slice(0, 160); },
      );
      return { ok: true };
    } catch (e) {
      failed++;
      lastError = String(e && e.message).slice(0, 160);
      return { ok: false, skipped: 'error' };
    }
  }

  return {
    push,
    stats: () => ({ enabled: cfg.enabled, url: cfg.url || null, format: cfg.format, sent, deduped, failed, lastError, fingerprints: throttle.size }),
    update(next) { Object.assign(cfg, next ?? {}); },
    /** 测试用：立即拿到配置快照 */
    get config() { return { ...cfg }; },
  };
}
