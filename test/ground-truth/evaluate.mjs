/**
 * Ground truth 评测器：对标注集跑静态体检卡 + 运行时探针，输出召回/误报硬数字
 *
 * 指标口径：
 *  - 告警召回 alarmRecall：红线样本中，两层检测合计命中 ≥1 条期望红线的比例（M1 目标 ≥90%）
 *  - 规则召回 ruleRecall：运行时红线规则逐条命中率
 *  - 行为召回：credentials / cleartext / subprocess / network 四类行为的检出率
 *  - 良性误报 fpRate：良性样本被报红线（任一层）的比例
 *  - observe 样本只记录不计分
 *
 * 用法：node test/ground-truth/evaluate.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { healthCard } from '../../src/inspector/health-card.js';
import { trustScore } from '../../src/inspector/trust-score.js';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const probe = req('../../src/probe/probe-core.cjs');

// ★ 时序 A：探针先装（样本具名导入才能拿到 wrapped 值）
probe.install();
probe.configure({ maxEvents: 50_000 });

const labels = JSON.parse(readFileSync(path.join(HERE, 'labels.json'), 'utf8')).samples;
globalThis.__gtHostCall = (cb) => cb(); // callback 变体的"宿主调用"

const NET = /^https?:|^fetch|^net\.|^(http|https)\./;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const perSample = [];
for (const label of labels) {
  const dir = path.join(HERE, 'samples', label.id);
  const row = { id: label.id, kind: label.kind, template: label.template, importStyle: label.importStyle };

  // ---------- 静态 ----------
  try {
    const card = healthCard(dir);
    row.static = {
      verdict: card.verdict,
      redLines: card.redLines.map((r) => r.rule),
      trust: trustScore({ redLines: card.redLines.map((r) => r.rule), capabilities: card.capabilities.map((c) => c.id) }).score,
    };
  } catch (error) {
    row.static = { error: String(error?.message ?? error) };
  }

  // ---------- 运行时 ----------
  try {
    probe.reset();
    probe.registerPlugin(label.id, dir);
    const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    await probe.runAs(label.id, () => mod.run());
    await sleep(120); // 等延迟/异步行为落地
    const events = probe.getEvents({ limit: 500 });
    const fired = [...new Set(probe.getRedFlags().map((f) => f.rule))];
    const flags = [...new Set(events.flatMap((e) => e.flags))];
    const byActor = {};
    for (const e of events) byActor[e.actor] = (byActor[e.actor] || 0) + 1;
    row.runtime = {
      redLines: fired,
      flags,
      network: events.some((e) => NET.test(e.api)),
      events: events.length,
      misattributed: (byActor.host || 0) + (byActor.unknown || 0),
      byActor,
    };
  } catch (error) {
    row.runtime = { error: String(error?.message ?? error).slice(0, 160) };
  }
  perSample.push(row);
}

// ---------- 计分 ----------
const EXPECT = Object.fromEntries(labels.map((l) => [l.id, l.expected]));
const redlineRows = perSample.filter((r) => r.kind === 'redline');
const benignRows = perSample.filter((r) => r.kind === 'benign');

let alarmHits = 0;
let ruleHit = 0, ruleTotal = 0;
const behaviorScore = { 'credentials-access': [0, 0], 'cleartext-http': [0, 0], subprocess: [0, 0], network: [0, 0] };
const staticRuleScore = {};
const runtimeRuleScore = {};

for (const r of perSample) {
  const exp = EXPECT[r.id];
  if (r.kind === 'redline') {
    const stHit = (r.static.redLines ?? []).some((x) => exp.static.redLines.includes(x));
    const rtHit = (r.runtime.redLines ?? []).some((x) => exp.runtime.redLines.includes(x));
    if (stHit || rtHit) alarmHits++;
    // 运行时规则逐条
    for (const rule of exp.runtime.redLines) {
      ruleTotal++;
      if ((r.runtime.redLines ?? []).includes(rule)) { ruleHit++; runtimeRuleScore[rule] = runtimeRuleScore[rule] || [0, 0]; runtimeRuleScore[rule][0]++; runtimeRuleScore[rule][1]++; }
      else { runtimeRuleScore[rule] = runtimeRuleScore[rule] || [0, 0]; runtimeRuleScore[rule][1]++; }
    }
    // 静态规则逐条
    for (const rule of exp.static.redLines) {
      const s = staticRuleScore[rule] = staticRuleScore[rule] || [0, 0];
      s[1]++;
      if ((r.static.redLines ?? []).includes(rule)) s[0]++;
    }
    // 行为类
    for (const f of ['credentials-access', 'cleartext-http', 'subprocess']) {
      if (exp.runtime.flags.includes(f)) {
        behaviorScore[f][1]++;
        if ((r.runtime.flags ?? []).includes(f)) behaviorScore[f][0]++;
      }
    }
    if (exp.runtime.flags.includes('network')) {
      behaviorScore.network[1]++;
      if (r.runtime.network) behaviorScore.network[0]++;
    }
  }
  if (r.kind === 'benign') {
    r.falsePositive = (r.static.redLines ?? []).length > 0 || (r.runtime.redLines ?? []).length > 0;
  }
}

const fpBenign = benignRows.filter((r) => r.falsePositive).length;
const metrics = {
  alarmRecall: { hit: alarmHits, total: redlineRows.length, pct: Math.round((alarmHits / redlineRows.length) * 100) },
  runtimeRuleRecall: { hit: ruleHit, total: ruleTotal, pct: ruleTotal ? Math.round((ruleHit / ruleTotal) * 100) : null },
  behaviorRecall: Object.fromEntries(Object.entries(behaviorScore).map(([k, [h, t]]) => [k, { hit: h, total: t, pct: t ? Math.round((h / t) * 100) : null }])),
  staticRuleRecall: Object.fromEntries(Object.entries(staticRuleScore).map(([k, [h, t]]) => [k, { hit: h, total: t, pct: Math.round((h / t) * 100) }])),
  benignFp: { fp: fpBenign, total: benignRows.length, pct: Math.round((fpBenign / benignRows.length) * 100) },
  observe: perSample.filter((r) => r.kind === 'observe'),
};

const out = { metrics, perSample };
mkdirSync(path.join(HERE, 'out'), { recursive: true });
writeFileSync(path.join(HERE, 'out', 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(metrics, null, 2));
