/**
 * 合规导出 —— M3「企业特性」之合规导出格式
 *
 * 这里刻意**不**做虚假的合规声明。本模块导出的是**格式**，不是认证：
 *   - SARIF 2.1.0：行业标准静态分析结果格式，GitHub code scanning / 各类 SAST 平台可直接消费；
 *     我们把自己的红线与判定映射成 SARIF 的 rule + result，让企业的既有流水线能接。
 *   - CSV：表格/工单系统导入用（审计员真正会打开的东西）。
 *
 * 明确不做的事（避免过度承诺，方案 §3.4）：
 *   - 不生成"符合 ISO 27001 / 等保 X 级"的结论——那是认证机构的判定，不是本工具的；
 *     我们只提供**可核查的行为证据**，供人工审计时引用。
 *   - 不隐藏证据来源：每条 result 都带 location（插件目录/事件目标）与时间戳。
 */

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = `https://json.schemastore.org/sarif-${SARIF_VERSION}.json`;
export const EXPORT_SCHEMA = 'dsh-pdr/compliance-export@1';

/** 红线规则 → SARIF reportingDescriptor（规则元数据集中在此，便于企业侧做策略映射） */
const RULE_META = {
  'credentials+network': {
    name: 'CredentialAccessWithNetwork',
    shortDescription: '插件读取凭据后又发起外联',
    fullDescription: '同一插件在观测窗口内既访问了凭据类文件，又发起了网络请求。'
      + '这是数据外泄的典型形态；但 IM/桥接类插件可能因功能必需而正常出现此组合，需人工确认。',
    level: 'error',
    tags: ['security', 'exfiltration'],
  },
  'credentials+subprocess': {
    name: 'CredentialAccessWithSubprocess',
    shortDescription: '插件读取凭据后又拉起子进程',
    fullDescription: '凭据访问与子进程执行共现，可能用于把凭据交给外部程序。', level: 'error',
    tags: ['security', 'exfiltration'],
  },
  'cleartext-http': {
    name: 'CleartextHttpEgress',
    shortDescription: '插件以明文 HTTP 访问非本机地址',
    fullDescription: '明文外联可被链路上任何人读取；若同时携带凭据则风险更高。'
      + '本机/保留地址不计入（宿主自身就常用 127.0.0.1）。',
    level: 'warning',
    tags: ['security', 'transport'],
  },
};

function metaFor(rule) {
  return RULE_META[rule] ?? {
    name: String(rule).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')),
    shortDescription: String(rule),
    fullDescription: `未登记元数据的规则：${rule}`,
    level: 'warning',
    tags: ['security'],
  };
}

/** 判定等级 → SARIF level 的映射（越界=error，可疑=warning，其余=note） */
function levelForVerdict(v) {
  if (v === 'boundary') return 'error';
  if (v === 'suspicious') return 'warning';
  return 'note';
}

/**
 * 生成 SARIF 2.1.0。
 *
 * @param {object} report generateAuditReport() 的输出
 * @param {object} [opts]
 * @param {string} [opts.uriBase] 把绝对路径映射成相对的 URI base（企业流水线需要稳定标识）
 */
export function toSarif(report, opts = {}) {
  const s = report.sections;
  const uriBase = opts.uriBase ?? null;

  // 出现过的规则集合（SARIF 要求 results 引用的 ruleId 必须在 rules 里声明）
  const usedRules = new Set();
  for (const f of s.redFlags) usedRules.add(f.rule);
  for (const v of s.pluginVerdicts) for (const r of v.redLines ?? []) usedRules.add(r);

  const rules = [...usedRules].map((rule) => {
    const m = metaFor(rule);
    return {
      id: rule,
      name: m.name,
      shortDescription: { text: m.shortDescription },
      fullDescription: { text: m.fullDescription },
      defaultConfiguration: { level: m.level },
      properties: { tags: m.tags },
    };
  });

  const toUri = (target) => {
    if (!target) return null;
    let t = String(target);
    if (uriBase && t.startsWith(uriBase)) {
      t = t.slice(uriBase.length).replace(/^[\\/]+/, '');
    }
    return t.replace(/\\/g, '/');
  };

  const results = [];

  // ① 红线事件 → results（有精确时间与目标的，证据最强）
  for (const f of s.redFlags) {
    const meta = metaFor(f.rule);
    results.push({
      ruleId: f.rule,
      level: meta.level,
      message: { text: `${f.actor} 触发 ${f.rule}` + (f.target ? `：${f.target}` : '') },
      locations: f.target ? [{ physicalLocation: { artifactLocation: { uri: toUri(f.target) } } }] : undefined,
      properties: {
        actor: f.actor,
        api: f.api ?? null,
        target: f.target ?? null,
        observedAt: new Date(f.t).toISOString(),
        evidence: 'runtime',
      },
    });
  }

  // ② 越界/可疑判定（没有对应红线事件时也要进报告，否则"判定"这个产出就丢了）
  const flaggedActors = new Set(s.redFlags.map((f) => f.actor));
  for (const v of s.pluginVerdicts) {
    if (v.verdict !== 'boundary' && v.verdict !== 'suspicious') continue;
    if (flaggedActors.has(v.actor) && (v.redLines ?? []).length) continue; // 已由 ① 覆盖
    const ruleId = (v.violations ?? [])[0]?.rule ?? `verdict:${v.verdict}`;
    results.push({
      ruleId,
      level: levelForVerdict(v.verdict),
      message: { text: `${v.actor} 判定为${v.zh}` + (v.violations?.length ? `（${v.violations.map((x) => x.rule).join('/')}）` : '') },
      properties: {
        actor: v.actor,
        verdict: v.verdict,
        violations: v.violations ?? [],
        evidence: 'judge',
      },
    });
  }

  // SARIF 要求 rules 覆盖所有 result.ruleId；把动态出现的缺口补上
  const declared = new Set(rules.map((r) => r.id));
  for (const r of results) {
    if (declared.has(r.ruleId)) continue;
    const m = metaFor(r.ruleId);
    rules.push({
      id: r.ruleId,
      name: m.name,
      shortDescription: { text: m.shortDescription },
      fullDescription: { text: m.fullDescription },
      defaultConfiguration: { level: m.level },
      properties: { tags: m.tags },
    });
    declared.add(r.ruleId);
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: 'DSH-PDR-Plugin',
          informationUri: 'https://github.com/kipozannaki/DSH-PDR-Plugin',
          version: opts.toolVersion ?? '0.2.1',
          rules,
        },
      },
      invocations: [{
        executionSuccessful: true,
        startTimeUtc: report.generatedAt,
        properties: {
          probeMode: s.probeHealth?.mode ?? null,
          totalEvents: s.probeHealth?.totalEvents ?? 0,
          pluginsObserved: s.executiveSummary?.pluginCount ?? 0,
          disclaimer: report.disclaimer,
        },
      }],
      // 载体（被审计的宿主进程）——SARIF 的 artifact 语义
      originalUriBaseIds: uriBase ? { '%SRCROOT%': { uri: uriBase.replace(/\\/g, '/') } } : undefined,
      results,
    }],
  };
}

/** CSV 转义：RFC 4180（含引号、逗号、换行的字段必须加引号并双写内部引号） */
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 生成 CSV（审计员/工单系统用）。
 * 列刻意选成"可核查"的：时间、插件、规则、证据目标、来源。
 */
export function toCsv(report) {
  const s = report.sections;
  const rows = [['observedAt', 'actor', 'kind', 'rule_or_verdict', 'api', 'target', 'evidence']];
  for (const f of s.redFlags) {
    rows.push([
      new Date(f.t).toISOString(), f.actor, 'redLine', f.rule, f.api ?? '', f.target ?? '', 'runtime',
    ]);
  }
  for (const v of s.pluginVerdicts) {
    if (v.verdict === 'normal') continue;
    rows.push([
      report.generatedAt, v.actor, 'verdict', v.verdict,
      (v.violations ?? []).map((x) => x.rule).join('/'), '', 'judge',
    ]);
  }
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

/**
 * 统一导出入口：一次拿到所有合规产物。
 * `formats` 可选 ['sarif','csv','json']，默认全出。
 */
export function buildComplianceExport(report, { formats = ['sarif', 'csv', 'json'], uriBase = null, toolVersion } = {}) {
  const out = {
    schema: EXPORT_SCHEMA,
    generatedAt: report.generatedAt,
    disclaimer: report.disclaimer,
    artifacts: {},
  };
  if (formats.includes('sarif')) out.artifacts.sarif = toSarif(report, { uriBase, toolVersion });
  if (formats.includes('csv')) out.artifacts.csv = toCsv(report);
  if (formats.includes('json')) out.artifacts.json = report;
  return out;
}
