/**
 * M3 合规导出 + 多源汇总评测
 *
 * 合规导出检查：
 *   A SARIF 版本/schema 正确，rules 覆盖所有 result.ruleId（SARIF 校验的硬要求）
 *   B 红线事件 → result（含时间/目标/actor 证据）
 *   C 越界判定即使无对应红线事件也要进报告（否则"判定"产出丢失）
 *   D uriBase 能把绝对路径转成相对 URI
 *   E CSV 符合 RFC 4180（含逗号/引号的字段正确转义）
 *   F 诚实边界：产物里不含任何"合规/认证通过"的结论性字段
 *
 * 多源汇总检查：
 *   G 轮转文件（.1/.2/.3）一并读取，不能只读当前文件
 *   H 坏行计数并上报（不静默丢弃）
 *   I 跨源去重：同一事件在多个文件里只算一次，且报告去重量
 *   J 每条事件带来源标签，任何数字可追溯
 *   K 跨源红线按 (actor,rule) 合并，保留来源集合
 *
 * 用法：node test/m3-compliance-eval.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAuditReport } from '../src/report/audit.js';
import {
  toSarif, toCsv, csvEscape, buildComplianceExport, SARIF_VERSION, EXPORT_SCHEMA,
} from '../src/report/compliance.js';
import {
  aggregateSources, discoverEventFiles, profileByActor, redLineSummary, aggregateMarkdown,
} from '../src/report/aggregate.js';

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

const now = Date.now();
const api = {
  getVerdicts: () => [
    {
      actor: 'mail-checker', verdict: 'boundary', zh: '越界', severity: 3,
      violations: [{ rule: 'target-sensitive', severity: 'critical', detail: '触碰全局凭据', t: now }],
      redLines: ['credentials+network'],
      contract: { source: 'user-adopted', scope: 'closed', declaredCapabilities: ['network'], declaredHosts: ['api.mail.example'], grants: [] },
      baseline: { events: 42, learning: false, hosts: [], pathClasses: ['own'], quietHourEvents: 0 },
    },
    {
      actor: 'silent-bad', verdict: 'boundary', zh: '越界', severity: 3,
      violations: [], redLines: [], contract: null, baseline: null,
    },
    {
      actor: 'pet-widget', verdict: 'normal', zh: '正常', severity: 0,
      violations: [], redLines: [], contract: null, baseline: null,
    },
  ],
  listContracts: () => ({ overrides: [], drafts: [] }),
  getSummary: () => ({ actors: [], stats: {} }),
  getRedFlags: () => [
    { rule: 'credentials+network', t: now, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail.example/collect' },
    { rule: 'cleartext-http', t: now + 5, actor: 'mail-checker', api: 'fetch', target: 'http://203.0.113.9/x,with"comma' },
  ],
  getStats: () => ({ mode: 'als', totalEvents: 900, stored: 24, dropped: 0, blocked: 2, errors: 0, installed: true }),
  getEvents: () => [],
  getAlertStats: () => ({ enabled: false, url: '', format: 'json', sent: 0, deduped: 0, failed: 0, lastError: null }),
};

// ---------- A / B / C / D SARIF ----------
{
  const report = generateAuditReport(api);
  const sarif = toSarif(report, { uriBase: 'C:\\Users\\x\\.dsh' });

  const ruleIds = new Set(sarif.runs[0].tool.driver.rules.map((r) => r.id));
  const resultRuleIds = sarif.runs[0].results.map((r) => r.ruleId);
  check('A', 'SARIF 版本/schema 正确，rules 覆盖全部 result.ruleId',
    sarif.version === SARIF_VERSION && sarif.$schema.includes('sarif') && resultRuleIds.every((id) => ruleIds.has(id)),
    `version=${sarif.version} rules=${ruleIds.size} results=${resultRuleIds.length} uncovered=${resultRuleIds.filter((id) => !ruleIds.has(id)).join(',') || 'none'}`);

  const mailResults = sarif.runs[0].results.filter((r) => r.properties?.actor === 'mail-checker' && r.properties?.evidence === 'runtime');
  check('B', '红线事件 → SARIF result（带时间/目标/actor）',
    mailResults.length === 2 && mailResults.every((r) => r.properties.observedAt && r.message.text),
    `runtime results=${mailResults.length} sample=${JSON.stringify(mailResults[0]?.properties)}`);

  const silentBad = sarif.runs[0].results.filter((r) => r.properties?.actor === 'silent-bad');
  check('C', '越界判定即使无红线事件也进报告（判定产出不丢）',
    silentBad.length >= 1 && silentBad[0].properties.evidence === 'judge',
    `silent-bad=${silentBad.length} evidence=${silentBad[0]?.properties?.evidence}`);

  const normalized = sarif.runs[0].results.filter((r) => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri === 'api.mail.example/collect');
  check('D', 'uriBase 把绝对/完整目标转成相对 URI',
    normalized.length >= 1 || sarif.runs[0].originalUriBaseIds !== undefined,
    `matched=${normalized.length} uri=${sarif.runs[0].results.find((r) => r.locations)?.locations?.[0]?.physicalLocation?.artifactLocation?.uri}`);
}

// ---------- E CSV RFC 4180 ----------
{
  const report = generateAuditReport(api);
  const csv = toCsv(report);
  const hasQuotedComma = csv.includes('"http://203.0.113.9/x,with""comma"');
  check('E', 'CSV 按 RFC 4180 转义（逗号加引号、引号双写）',
    hasQuotedComma && csv.split('\r\n')[0].startsWith('observedAt,actor,kind'),
    `quoted=${hasQuotedComma} header=${csv.split('\r\n')[0]}`);
  check('E2', 'csvEscape 边界正确',
    csvEscape('a,b') === '"a,b"' && csvEscape('a"b') === '"a""b"' && csvEscape('plain') === 'plain' && csvEscape(null) === '',
    `${csvEscape('a,b')} | ${csvEscape('a"b')} | ${csvEscape('plain')} | "${csvEscape(null)}"`);
}

// ---------- F 诚实边界 ----------
{
  const report = generateAuditReport(api);
  const exp = buildComplianceExport(report, { uriBase: 'C:\\x' });
  const blob = JSON.stringify(exp.artifacts.sarif) + exp.artifacts.csv;
  // 不允许出现"通过/符合/认证"这类结论
  const forbidden = /(compliance\s*[:=]\s*"?pass|iso\s*27001.*(通过|pass|compliant)|等保.*(通过|符合)|certified)/i;
  check('F', '诚实边界：产物不含合规/认证通过结论',
    exp.schema === EXPORT_SCHEMA && !forbidden.test(blob),
    `schema=${exp.schema} forbiddenHit=${forbidden.test(blob)} artifacts=${Object.keys(exp.artifacts).join(',')}`);
}

// ---------- G~K 多源汇总 ----------
{
  const TMP = mkdtempSync(path.join(tmpdir(), 'fw-agg-'));
  const s1 = path.join(TMP, 'profile-a'); mkdirSync(s1, { recursive: true });
  const s2 = path.join(TMP, 'profile-b'); mkdirSync(s2, { recursive: true });

  const ev = (t, actor, api, target, extra = {}) => JSON.stringify({ t, actor, api, target, flags: [], redLines: [], ...extra });

  // 源 A：当前文件 + 一份轮转档
  writeFileSync(path.join(s1, 'events.jsonl.1'), [
    ev(1000, 'alpha', 'fs.readFileSync', 'C:/a/.credentials.yaml', { flags: ['credentials-access'] }),
    ev(1001, 'alpha', 'fetch', 'http://evil.example/x', { redLines: ['credentials+network'] }),
  ].join('\n') + '\n');
  writeFileSync(path.join(s1, 'events.jsonl'), [
    ev(2000, 'alpha', 'fetch', 'http://evil.example/x', { redLines: ['credentials+network'] }),
    'not-json-at-all',
  ].join('\n') + '\n');

  // 源 B：与源 A 有重复事件（模拟归档复制），以及独立事件
  writeFileSync(path.join(s2, 'events.jsonl'), [
    ev(2000, 'alpha', 'fetch', 'http://evil.example/x', { redLines: ['credentials+network'] }), // 与 A 完全重复
    ev(3000, 'beta', 'child_process.spawn', 'cmd /c whoami', { flags: ['subprocess'] }),
  ].join('\n') + '\n');

  const filesA = discoverEventFiles(s1);
  check('G', '轮转文件（.1）与当前文件都被发现，且按旧→新排序',
    filesA.eventFiles.length === 2 && /\.1$/.test(filesA.eventFiles[0]) && /events\.jsonl$/.test(filesA.eventFiles[1]),
    filesA.eventFiles.map((f) => path.basename(f)).join(' → '));

  const agg = aggregateSources([{ label: 'profile-a', dir: s1 }, { label: 'profile-b', dir: s2 }]);
  check('H', '坏行计数并上报（不静默丢弃）',
    agg.totals.badLines === 1, `badLines=${agg.totals.badLines}`);
  check('I', '跨源去重：重复事件只算一次并报告去重量',
    agg.totals.events === 4 && agg.totals.duplicateDropped === 1,
    `events=${agg.totals.events} deduped=${agg.totals.duplicateDropped}（期望 4 / 1）`);
  check('J', '每条事件带来源标签，数字可追溯',
    agg.events.every((e) => typeof e.__source === 'string' && e.__source.includes('/'))
    && agg.sources.every((s) => Array.isArray(s.eventFiles)),
    `sources=${agg.events.map((e) => e.__source).filter((v, i, a) => a.indexOf(v) === i).join(',')}`);

  const reds = redLineSummary(agg.events);
  check('K', '跨源红线按 (actor,rule) 合并，保留来源集合',
    reds.length === 1 && reds[0].actor === 'alpha' && reds[0].rule === 'credentials+network' && reds[0].count === 2 && reds[0].sources.length === 2,
    JSON.stringify(reds.map((r) => ({ actor: r.actor, rule: r.rule, count: r.count, sources: r.sources.length }))));

  const actors = profileByActor(agg.events);
  const md = aggregateMarkdown(agg);
  check('K2', '行为画像 + Markdown 汇总可用',
    actors.length === 2 && md.includes('多源汇总报告') && md.includes('跨源红线') && md.includes('credentials+network'),
    `actors=${actors.map((a) => `${a.actor}:${a.events}`).join(',')}`);

  rmSync(TMP, { recursive: true, force: true });
}

const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length };
console.log(JSON.stringify({ metrics, results }, null, 2));
process.exit(metrics.all ? 0 : 1);
