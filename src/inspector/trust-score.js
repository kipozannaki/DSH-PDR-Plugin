/**
 * 信任分（方案 §4.1④：0-100，可解释、可审计）
 *
 * 公式（故意保持简单透明，黑盒打分不配叫安全产品）：
 *   score = 100
 *     - 30 × 红线条数            （上限 -70，红线是最重的信号）
 *     - 行为扣分（运行时实测优先于静态声明）：
 *         凭据访问事件 × 5（上限 -20）
 *         网络事件     × 3（上限 -15）
 *         子进程事件   × 2（上限 -10）
 *     - 能力面扣分（静态体检卡）：
 *         network + shell 同现 -10
 *         dynamic-code -5
 *   结果截断到 [0, 100]
 *
 * 分档：≥80 良好 / 60-79 注意 / 40-59 谨慎 / <40 高危
 */

export const TRUST_BANDS = [
  { min: 80, label: '良好', tone: 'good' },
  { min: 60, label: '注意', tone: 'warn' },
  { min: 40, label: '谨慎', tone: 'warn' },
  { min: 0, label: '高危', tone: 'bad' },
];

export function trustScore({ redLines = [], behavior = {}, capabilities = [] } = {}) {
  const has = (id) => capabilities.includes(id);
  let score = 100;
  score -= Math.min(70, redLines.length * 30);
  score -= Math.min(20, (behavior.credentials || 0) * 5);
  score -= Math.min(15, (behavior.network || 0) * 3);
  score -= Math.min(10, (behavior.subprocess || 0) * 2);
  if (has('network') && has('shell')) score -= 10;
  if (has('dynamic-code')) score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = TRUST_BANDS.find((b) => score >= b.min) || TRUST_BANDS[TRUST_BANDS.length - 1];
  return { score, band: band.label, tone: band.tone };
}
