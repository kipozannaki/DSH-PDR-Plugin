/**
 * 第 3 项 · M3 评测：企业审计报告 + 兼容证据（upstream-radar 对接地基）
 *
 * 检查：
 *  ① 审计报告结构完整（执行摘要/判定/契约/红线/时间线/探针健康/免责）
 *  ② Markdown 渲染含各段
 *  ③ 兼容证据 schema 正确（loads/starts/gate + change + evidence）
 *  ④ 兼容证据在无 trial/diff 时形状稳定（null 段 + 有 evidence）
 *
 * 用法：node test/m3-report-eval.mjs
 */
import { generateAuditReport, auditReportMarkdown } from '../src/report/audit.js';
import { report } from './_report.mjs';
import { buildCompatReport, COMPAT_SCHEMA } from '../src/update/compat.js';
import { diffDirs } from '../src/update/diff.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

// 逼真 mock api（形状 = probe + judge 的真实输出）
const now = Date.now();
const api = {
  getVerdicts: () => [
    {
      actor: 'mail-checker', verdict: 'boundary', zh: '越界', severity: 3,
      violations: [{ rule: 'target-sensitive', severity: 'critical', detail: '触碰全局凭据', t: now, api: 'fs.readFileSync', target: 'C:\\x\\.credentials.yaml' }],
      redLines: ['credentials+network'],
      contract: { source: 'user-adopted', scope: 'closed', declaredCapabilities: ['network', 'credentials'], declaredHosts: ['api.mail.example'], grants: [] },
      baseline: { events: 42, learning: false, hosts: ['api.mail.example'], pathClasses: ['own'], quietHourEvents: 0 },
    },
    {
      actor: 'pet-widget', verdict: 'normal', zh: '正常', severity: 0,
      violations: [], redLines: [],
      contract: { source: 'health-card', scope: 'open', declaredCapabilities: ['fs-read'], declaredHosts: [], grants: [] },
      baseline: { events: 10, learning: true, hosts: [], pathClasses: ['own'], quietHourEvents: 0 },
    },
  ],
  listContracts: () => ({ overrides: [{ name: 'mail-checker', declaredHosts: ['api.mail.example'] }], drafts: [] }),
  getSummary: () => ({ actors: [], stats: {} }),
  getRedFlags: () => [{ rule: 'credentials+network', t: now, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail.example/collect' }],
  getStats: () => ({ mode: 'both', totalEvents: 825, stored: 24, dropped: 0, blocked: 3, errors: 0, installed: true, registeredPlugins: ['mail-checker', 'pet-widget'] }),
  getEvents: () => [
    { t: now, actor: 'mail-checker', api: 'fs.readFileSync', target: 'C:\\x\\.credentials.yaml', flags: ['credentials-access'] },
    { t: now + 800, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail.example/collect', flags: ['cleartext-http'] },
  ],
};

// ---------- ① + ② 审计报告 ----------
{
  const report = generateAuditReport(api);
  const s = report.sections;
  check('A', '审计报告结构完整', !!(
    s.executiveSummary && s.pluginVerdicts && s.contracts && s.redFlags && s.behaviorTimeline && s.probeHealth && report.disclaimer
  ), Object.keys(s).join(','));
  check('B', '执行摘要含判定分布/拦截数', s.executiveSummary.verdictBreakdown.boundary === 1 && s.executiveSummary.blockedCount === 3 && s.executiveSummary.pluginCount === 2, JSON.stringify(s.executiveSummary));
  check('C', '判定含契约/违规/红线', s.pluginVerdicts[0].contract?.source === 'user-adopted' && s.pluginVerdicts[0].violations.length === 1 && s.pluginVerdicts[0].redLines.includes('credentials+network'));
}
{
  const md = auditReportMarkdown(generateAuditReport(api));
  check('D', 'Markdown 渲染各段', ['# DSH-PDR-Plugin', '## 执行摘要', '## 插件判定', '## 红线明细', '## 探针健康', 'mail-checker', '越界'].every((t) => md.includes(t)), md.split('\n').slice(0, 3).join(' / '));
}

// ---------- ③ + ④ 兼容证据 ----------
{
  const TMP = mkdtempSync(path.join(tmpdir(), 'fw-compat-'));
  const before = path.join(TMP, 'b'); mkdirSync(before); writeFileSync(path.join(before, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: {} })); writeFileSync(path.join(before, 'index.mjs'), `fs_x();`);
  const after = path.join(TMP, 'a'); mkdirSync(after); writeFileSync(path.join(after, 'package.json'), JSON.stringify({ name: 'p', version: '2.0.0', dependencies: { axios: '1' } })); writeFileSync(path.join(after, 'index.mjs'), `fetch('https://x.com'); api_key = 'abc';`);
  const diff = diffDirs(before, after);
  const trial = { importOk: true, startOk: true, verdict: 'WARN', reason: '红线', redFlags: ['credentials+network'], behaviors: [{}] };

  const report = buildCompatReport({ name: 'p', version: '2.0.0', trial, diff });
  check('E', '兼容证据 schema 正确', report.schema === COMPAT_SCHEMA && report.plugin.name === 'p', report.schema);
  check('F', 'compatibility 含 loads/starts/gate', report.compatibility.loads === true && report.compatibility.starts === true && report.compatibility.gate === 'WARN', JSON.stringify(report.compatibility));
  check('G', 'change 含能力/红线/契约影响', report.change.capabilitiesAdded.includes('network') && report.change.redLinesAdded.includes('credentials+network') && report.change.contractImpact === 'broader', JSON.stringify(report.change.capabilitiesAdded));
  check('H', 'evidence 标注隔离 + 来源', report.evidence.isolated === true && report.evidence.source.includes('dsh-pdr-plugin'), JSON.stringify(report.evidence.source));

  const empty = buildCompatReport({ name: 'p' });
  check('I', '无 trial/diff 形状稳定（null 段 + 有 evidence）', empty.compatibility === null && empty.change === null && empty.schema === COMPAT_SCHEMA && !!empty.evidence.at);
  rmSync(TMP, { recursive: true, force: true });
}

const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length };
report({ metrics, results });
