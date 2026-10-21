/**
 * 企业审计报告 —— 方案 §4.1④「一键导出审计报告」（企业场景钩子）
 *
 * 汇总判定/契约/红线/时间线/探针健康成一份结构化审计报告（JSON + 人读 Markdown），
 * 供企业合规留档。本地生成，不上传任何遥测。
 */
export function generateAuditReport(api) {
  const verdicts = typeof api.getVerdicts === 'function' ? api.getVerdicts() : [];
  const contracts = typeof api.listContracts === 'function' ? api.listContracts() : { overrides: [], drafts: [] };
  const summary = api.getSummary();
  const redFlags = api.getRedFlags();
  const stats = api.getStats();
  const events = api.getEvents({ limit: 1000 });

  const verdictBreakdown = verdicts.reduce((m, v) => ((m[v.verdict] = (m[v.verdict] || 0) + 1), m), {});

  return {
    title: 'DSH-PDR-Plugin 安全审计报告',
    generatedAt: new Date().toISOString(),
    disclaimer: '本报告由静态能力面 + 运行时行为 + 红线组合 + 越界判定综合生成，'
      + '为安全审计辅助材料，不替代人工审查；全部数据仅存本机，未上传任何遥测。',
    sections: {
      executiveSummary: {
        pluginCount: verdicts.length,
        verdictBreakdown, // { normal, observe, suspicious, boundary }
        redFlagCount: redFlags.length,
        blockedCount: stats.blocked ?? 0,
        totalEvents: stats.totalEvents ?? 0,
      },
      pluginVerdicts: verdicts.map((v) => ({
        actor: v.actor,
        verdict: v.verdict,
        zh: v.zh,
        severity: v.severity,
        violations: v.violations,
        redLines: v.redLines,
        contract: v.contract ? {
          source: v.contract.source, scope: v.contract.scope,
          capabilities: v.contract.declaredCapabilities ?? v.contract.capabilities,
          declaredHosts: v.contract.declaredHosts,
          grants: v.contract.grants,
        } : null,
        baseline: v.baseline,
      })),
      contracts: { overrides: contracts.overrides ?? [], drafts: contracts.drafts ?? [] },
      redFlags,
      behaviorTimeline: events,
      probeHealth: stats,
      /**
       * 告警外发状态：企业审计必须能回答"红线有没有被送出去、送到哪、失败几次"。
       * 只记目标地址的**协议+主机**，不记完整 URL（可能含 token 查询参数）。
       */
      alertDelivery: typeof api.getAlertStats === 'function'
        ? sanitizeAlertStats(api.getAlertStats())
        : null,
    },
  };
}

/** 把 webhook URL 脱敏成 origin（去掉 path/query，避免把 token 写进审计报告） */
function sanitizeAlertStats(s) {
  if (!s) return null;
  let origin = null;
  try { origin = s.url ? new URL(s.url).origin : null; } catch { origin = '(invalid-url)'; }
  return {
    enabled: !!s.enabled,
    target: origin,
    format: s.format,
    sent: s.sent,
    deduped: s.deduped,
    failed: s.failed,
    lastError: s.lastError,
  };
}

/** 人读 Markdown（企业留档/粘贴工单用） */
export function auditReportMarkdown(report) {
  const s = report.sections;
  const lines = [
    `# ${report.title}`,
    ``,
    `> 生成时间：${report.generatedAt}`,
    `> ${report.disclaimer}`,
    ``,
    `## 执行摘要`,
    `- 插件数：${s.executiveSummary.pluginCount}`,
    `- 判定分布：${Object.entries(s.executiveSummary.verdictBreakdown).map(([k, n]) => `${k}=${n}`).join(' ') || '无'}`,
    `- 红线告警：${s.executiveSummary.redFlagCount}`,
    `- 已拦截：${s.executiveSummary.blockedCount}`,
    `- 行为事件：${s.executiveSummary.totalEvents}`,
    ``,
    `## 插件判定`,
    `| 插件 | 判定 | 违规 | 红线 | 契约来源 |`,
    `|---|---|---|---|---|`,
    ...s.pluginVerdicts.map((v) =>
      `| ${v.actor} | ${v.zh} | ${v.violations.map((x) => x.rule).join('/') || '-'} | ${v.redLines.join('/') || '-'} | ${v.contract?.source ?? '-'} |`),
    ``,
    `## 红线明细`,
    ...(s.redFlags.length
      ? s.redFlags.map((f) => `- ${new Date(f.t).toLocaleString()} · ${f.actor} · ${f.rule} · ${f.target ?? f.api ?? ''}`)
      : ['- 无']),
    ``,
    `## 探针健康`,
    `- 模式：${s.probeHealth.mode} · 事件：${s.probeHealth.totalEvents} · 拦截：${s.probeHealth.blocked ?? 0} · 丢弃：${s.probeHealth.dropped} · 错误：${s.probeHealth.errors}`,
    ``,
    `## 告警外发`,
    ...(s.alertDelivery
      ? [
        `- 状态：${s.alertDelivery.enabled ? '已启用' : '未启用（默认：全部数据仅存本机）'}`,
        `- 目标：${s.alertDelivery.target ?? '未配置'}`,
        `- 已送达：${s.alertDelivery.sent} · 去重跳过：${s.alertDelivery.deduped} · 失败：${s.alertDelivery.failed}`,
        ...(s.alertDelivery.lastError ? [`- 最近错误：${s.alertDelivery.lastError}`] : []),
      ]
      : ['- 未接入告警推送']),
  ];
  return lines.join('\n');
}
