/**
 * 拦截策略模型 —— 判出违规后"怎么办"
 *
 * 三层覆盖（最具体的赢）：
 *   plugins[actor]  某插件的模式（用户明确表态"我信这个插件"或"重点盯它"）
 *   rules[rule]     某类违规的模式（如"敏感路径一律拦"）
 *   mode            全局默认：'alarm'（只告警，方案 §6.1 默认）| 'block'（拦截）
 *
 * 三种动作：
 *   allow  放行（不告警，少用）
 *   alarm  放行 + 记录告警（默认；对应 Monitor 模式）
 *   block  拦截：抛 FirewallBlockError，插件看到受控错误（对应 Block 模式，opt-in）
 *
 * 安全取向：Block 是显式开启的；开启后不确定时倾向拦（fail-closed），
 * 但拦截动作本身受控（抛错给插件），且宿主自身/自观测永不被拦（探针层排除）。
 */
export const ACTIONS = ['allow', 'alarm', 'block'];

export class Policy {
  constructor({ mode = 'alarm', rules = {}, plugins = {} } = {}) {
    this.mode = ACTIONS.includes(mode) ? mode : 'alarm';
    this.rules = { ...rules };
    this.plugins = { ...plugins };
  }

  /** 最具体的赢：插件 > 规则 > 全局 */
  decide(actor, rule) {
    const p = this.plugins[actor];
    if (p && ACTIONS.includes(p)) return p;
    const r = this.rules[rule];
    if (r && ACTIONS.includes(r)) return r;
    return this.mode;
  }

  update({ mode, rules, plugins } = {}) {
    if (mode && ACTIONS.includes(mode)) this.mode = mode;
    if (rules) Object.assign(this.rules, rules);
    if (plugins) Object.assign(this.plugins, plugins);
    return this;
  }

  toJSON() {
    return { mode: this.mode, rules: { ...this.rules }, plugins: { ...this.plugins } };
  }

  static alarmOnly() {
    return new Policy({ mode: 'alarm' });
  }
}
