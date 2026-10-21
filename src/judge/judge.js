/**
 * 越界判定核心 —— 用"该干什么"量"实际干了什么"
 *
 * 三把尺子：
 *   声明契约（contract.js）：能力面 / 目的地 / 显式授权 —— 越出声明 = 违规
 *   路径分类（paths.js）：敏感目标 / 跨插件目标 —— 碰不该碰的 = 违规
 *   行为基线（baseline.js）：跟自己平时比 —— 反常 = 观察级提示
 *
 * 分级（沿用"默认不替用户做决定"）：
 *   critical 越界   目标敏感（凭据/密钥）或 出范围外联携带凭据（红线+目的地违规）
 *   warn     可疑   能力面/目的地/跨插件范围违规
 *   info     观察   基线偏移（新目的地、静默时段、频率突增）
 *   无       正常   本职范围内，零打扰
 */
import path from 'node:path';
import { classifyPath, hostOf } from './paths.js';
import { deriveContract, normalizeContract, contractAllowsApi, contractAllowsPathClass, contractAllowsHost, apiClassOf } from './contract.js';
import { Baseline } from './baseline.js';

export const VERDICT = {
  boundary: { key: 'boundary', zh: '越界', severity: 3 },
  suspicious: { key: 'suspicious', zh: '可疑', severity: 2 },
  observe: { key: 'observe', zh: '观察', severity: 1 },
  normal: { key: 'normal', zh: '正常', severity: 0 },
};
const SEV = { info: 1, warn: 2, critical: 3 };

export class Judge {
  constructor({ dataDir = null, baselineOpts = {} } = {}) {
    this.contracts = new Map();
    this.ownDirs = new Map();   // actor -> [dir]
    this.pluginDirs = new Map(); // dir -> actor
    this.violations = new Map(); // actor -> [violation]
    this.redlines = new Map();   // actor -> [rule]
    this.baseline = new Baseline(baselineOpts);
    this.dataDir = dataDir;
    if (dataDir) this.baseline.load(path.join(dataDir, 'baseline.json'));
  }

  registerPlugin(name, dir) {
    this.ownDirs.set(name, [...(this.ownDirs.get(name) ?? []), dir]);
    this.pluginDirs.set(dir.replace(/\\/g, '/'), name);
    // 注意：不在此预置契约——契约由 ensureContract 按体检卡能力面懒派生，
    // 否则弱默认契约会挡住升级（M1 实测教训）
  }

  setContract(name, contract) { this.contracts.set(name, normalizeContract(contract)); }
  getContract(name) { return this.contracts.get(name) ?? null; }

  /** 消费一个行为事件，返回本次产生的违规列表 */
  observe(event) {
    const actor = event?.actor;
    if (!actor || actor === 'host' || actor === 'self') return []; // 宿主/自身不判定

    const contract = this.contracts.get(actor) ?? deriveContract({ name: actor });
    const out = [];
    const add = (rule, severity, detail) => out.push({
      rule, severity, detail,
      t: event.t ?? Date.now(), api: event.api, target: String(event.target ?? '').slice(0, 160),
    });

    // ① 能力面越界：做了声明之外类别的事
    if (!contractAllowsApi(contract, event.api)) {
      add('capability-deviation', 'warn', `未声明 ${apiClassOf(event.api)} 能力却执行了 ${event.api}`);
    }

    // ② 目标越界：碰了不该碰的文件
    let pathInfo = { class: 'other', detail: '' };
    if (String(event.api).startsWith('fs')) {
      pathInfo = classifyPath(event.target, {
        ownDirs: this.ownDirs.get(actor) ?? [],
        pluginDirs: this.pluginDirs,
      });
      if (pathInfo.class === 'sensitive' && !contractAllowsPathClass(contract, 'sensitive')) {
        add('target-sensitive', 'critical', '触碰全局凭据/密钥类敏感路径');
      }
      if (pathInfo.class === 'other-plugin' && !contractAllowsPathClass(contract, 'other-plugin')) {
        add('target-other-plugin', 'warn', `触碰其他插件（${pathInfo.detail}）的文件`);
      }
    }

    // ③ 目的地越界：连了声明之外的地方（仅对声明过 hosts 的契约生效，避免误报）
    const host = hostOf(event.target);
    if (host && apiClassOf(event.api) === 'network' && !contractAllowsHost(contract, host)) {
      add('destination-scope', 'warn', `连接未声明目的地 ${host}`);
    }

    // ④ 基线偏移（观察级）
    for (const d of this.baseline.observe(event, { host, pathClass: pathInfo.class })) {
      add(d.rule, 'info', d.detail);
    }

    if (out.length) {
      this.violations.set(actor, [...(this.violations.get(actor) ?? []), ...out]);
    }
    return out;
  }

  /** 红线告警联动（来自探针规则）：红线 + 出范围外联 = 升级为越界 */
  observeRedFlag(flag) {
    const actor = flag?.actor;
    if (!actor) return;
    const rules = this.redlines.get(actor) ?? [];
    if (!rules.includes(flag.rule)) rules.push(flag.rule);
    this.redlines.set(actor, rules);

    if (flag.rule === 'credentials+network') {
      const list = this.violations.get(actor) ?? [];
      for (const v of list) {
        if (v.rule === 'destination-scope' && (SEV[v.severity] ?? 0) < SEV.critical) {
          v.severity = 'critical';
          v.detail += '（伴随凭据外发红线 → 升级）';
          v.rule = 'exfil-out-of-scope';
        }
      }
    }
  }

  getVerdict(actor) {
    const list = this.violations.get(actor) ?? [];
    const severity = list.reduce((m, v) => Math.max(m, SEV[v.severity] ?? 0), 0);
    const verdict = Object.values(VERDICT).find((v) => v.severity === severity) ?? VERDICT.normal;
    return {
      actor,
      verdict: verdict.key,
      zh: verdict.zh,
      severity,
      violations: list,
      redLines: this.redlines.get(actor) ?? [],
      contract: this.contracts.get(actor) ?? null,
      baseline: this.baseline.stats(actor),
    };
  }

  getVerdicts() {
    const actors = new Set([
      ...this.contracts.keys(),
      ...this.violations.keys(),
      ...this.redlines.keys(),
    ]);
    return [...actors].map((a) => this.getVerdict(a)).sort((x, y) => y.severity - x.severity);
  }

  save() {
    if (this.dataDir) this.baseline.save(path.join(this.dataDir, 'baseline.json'));
  }
}
