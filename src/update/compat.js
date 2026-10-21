/**
 * 兼容证据适配 —— 方案 §4.1③「对接 upstream-radar 的机器可读兼容数据（不重复造轮子）」
 *
 * 把本插件产出的兼容信号（隔离试装 + 更新 diff）组织成**机器可读的兼容证据**，
 * 形状对齐"兼容验证工具"类生态（upstream-radar 一类）消费的数据：
 *   - 能不能加载 / 能不能启动 / 门禁判定（PASS/WARN/FAIL）
 *   - 能力面/红线变化（这次更新改了什么）
 *   - 证据来源与时间戳（可追溯）
 *
 * 诚实边界：upstream-radar 的**实际** schema 未公开获取，本模块定义"我方"的证据格式
 * （`dsh-pdr-compat/1`），真正的对接需按其格式做映射——这是对接的准备工作，不是已完成的集成。
 */

export const COMPAT_SCHEMA = 'dsh-pdr-compat/1';

/**
 * @param name   插件名
 * @param version 版本（可选）
 * @param trial  trialInstall() 的结果（可选）
 * @param diff   diffVersions() 的结果（可选）
 */
export function buildCompatReport({ name, version = '', trial = null, diff = null } = {}) {
  return {
    schema: COMPAT_SCHEMA,
    plugin: { name, version },
    compatibility: trial ? {
      loads: !!trial.importOk,
      starts: !!trial.startOk,
      gate: trial.verdict, // PASS | WARN | FAIL
      reason: trial.reason,
      redFlags: [...new Set(trial.redFlags ?? [])],
      behaviors: (trial.behaviors ?? []).length,
    } : null,
    change: diff ? {
      capabilitiesAdded: diff.capabilities?.added ?? [],
      capabilitiesRemoved: diff.capabilities?.removed ?? [],
      redLinesAdded: diff.redLines?.added ?? [],
      redLinesRemoved: diff.redLines?.removed ?? [],
      contractImpact: diff.contractImpact, // broader | narrower | same
      verdictChange: diff.verdictChange,
      summary: diff.summary,
    } : null,
    evidence: {
      source: 'dsh-pdr-plugin (isolated trial-install + update-diff)',
      isolated: true, // 试装在子进程 + 一次性 DSH_HOME 中进行
      at: new Date().toISOString(),
    },
  };
}

/** 从试装结果 + 更新 diff 一键产出兼容证据 */
export function compatFromUpdate({ name, version, trial, diff }) {
  return buildCompatReport({ name, version, trial, diff });
}
