/**
 * 测试统一收尾：打印结果 + **设置退出码**。
 *
 * 为什么必须有这个文件：开源前审计发现 24 个测试里只有 4 个会设置退出码，
 * 其余失败时仍然 `exit 0`——CI 上永远是绿的，"测试全绿"是假象。
 * 真实案例：`smoke.mjs` 长期输出 `"ok": false`（victim 归因失败），
 * 但因为不设退出码，一直被当成 PASS。
 *
 * 用法：把结尾的 `console.log(JSON.stringify(x, null, 2))` 换成 `report(x)`
 * （或 `report(x, messages)`，messages 为额外的可读输出）。
 */
import { inspect } from 'node:util';

/**
 * 从任意结果对象里判定通过与否。
 * 兼容现有各种形状，避免为统一字段而改 20 个测试的断言结构。
 * @returns {boolean|null} null = 无法判定
 */
export function verdictOf(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // 显式布尔字段（优先级从高到低）
  for (const key of ['all', 'ok', 'pass']) {
    if (typeof payload[key] === 'boolean') return payload[key];
  }
  // { metrics: { all } }
  if (payload.metrics && typeof payload.metrics.all === 'boolean') return payload.metrics.all;
  // { summary: { verdict } }
  if (payload.summary && typeof payload.summary.verdict === 'string') {
    if (/^PASS$/i.test(payload.summary.verdict)) return true;
    if (/^FAIL/i.test(payload.summary.verdict)) return false;
  }
  // { checks: {...booleans} }（smoke.mjs 形状）
  if (payload.checks && typeof payload.checks === 'object') {
    const vals = Object.values(payload.checks).filter((v) => typeof v === 'boolean');
    if (vals.length) return vals.every(Boolean);
  }
  // { results: [{ pass }] }
  if (Array.isArray(payload.results) && payload.results.length) {
    const vals = payload.results.map((r) => r && r.pass).filter((v) => typeof v === 'boolean');
    if (vals.length) return vals.every(Boolean);
  }
  // { passed, total }
  if (typeof payload.passed === 'number' && typeof payload.total === 'number') {
    return payload.passed === payload.total;
  }
  return null;
}

/**
 * 打印并设退出码。
 * @param {object} payload 结果对象
 * @param {string[]} [notes] 额外的可读说明（打印到 stderr，不污染 JSON）
 * @param {object} [opts]
 * @param {boolean} [opts.requireVerdict] 无法判定时视为失败（默认 true：宁可红也不假绿）
 */
export function report(payload, notes = [], opts = {}) {
  console.log(JSON.stringify(payload, null, 2));
  if (notes.length) for (const n of notes) console.error(n);

  // 明确跳过：退出 0，但与"通过"在输出上可区分
  if (payload && payload.skipped === true) {
    process.exitCode = 0;
    console.error(`SKIP: ${payload.reason ?? '（未说明原因）'}`);
    if (payload.howToRun) console.error(`  需要真实环境时：${payload.howToRun}`);
    return false;
  }

  const verdict = verdictOf(payload);
  const requireVerdict = opts.requireVerdict !== false;

  if (verdict === true) {
    process.exitCode = 0;
    return true;
  }
  if (verdict === null && !requireVerdict) {
    process.exitCode = 0;
    console.error('note: 结果里没有可判定的通过字段，按配置视为通过');
    return true;
  }
  process.exitCode = 1;
  if (verdict === null) {
    console.error('FAIL: 结果里没有可判定的通过字段（all/ok/pass/metrics.all/results[].pass）');
    console.error('      这是测试自身的问题，不是被测代码的问题——请让测试输出带上判定字段。');
  }
  return false;
}

/** 便于调试：把任意值打到 stderr，不影响 JSON 输出 */
export function debug(...args) {
  console.error('[debug]', ...args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 }))));
}

/**
 * 明确跳过：环境不具备（缺真实插件、缺外部数据）时用。
 *
 * 与"通过"必须可区分——退出码同为 0，但输出 `skipped: true` 且 stderr 大声说明原因与复原方法。
 * 开源后这一点很重要：别人机器上没有作者的 profile，
 * 静默通过会让人以为被测代码被验证过，其实是根本没跑。
 */
export function skip(reason, howToRun = null) {
  console.log(JSON.stringify({ skipped: true, reason, howToRun }, null, 2));
  console.error(`SKIP: ${reason}`);
  if (howToRun) console.error(`  需要真实环境时：${howToRun}`);
  // 必须真的停下来：调用方在后面通常还有 report()，继续执行会把
  // 退出码重新写成 1，于是"跳过"变成"失败"（真机踩过）。
  process.exitCode = 0;
  process.exit(0);
}
