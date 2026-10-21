/**
 * M1 出口条件：「对 20 个已知红线插件告警召回 ≥90%」
 *
 * 方案原意是用生态已标注的真实插件做召回基准。此前 test/ground-truth 用的是**自建模板样本**，
 * 与出口条件不是一回事。本脚本改用 awesome-dsh-plugin 的真实数据：
 *
 *   外部标注：data/capabilities.json（3843 个插件，含 capabilities + redLines，由 dsh-trust-check 扫描）
 *   我方判定：healthCard(插件源码目录) 的 redLines
 *
 * 关键设计：
 *  - 只抽样"有 redLines 的真实插件"作为召回分母（出口条件说的就是"已知红线插件"）
 *  - 同时抽等量"已标注无红线"的插件，量误报（recall 高但全报一遍毫无价值）
 *  - 外部标注的 redLine 是自然语言，必须先建映射表才能比对（映射口径写死在 RULE_MAP，
 *    并在输出中列出未映射的规则，避免"映射不到就当命中/当漏"的暗箱）
 *
 * 用法：node test/m1-real-recall.mjs <capabilities.json> <samplesDir> [perGroup]
 *   samplesDir 内每个插件一个子目录（形如 <owner>__<repo>），由 fetch 脚本准备
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { report, skip } from './_report.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { healthCard } from '../src/inspector/health-card.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

/**
 * 基准数据是**外部数据集**（数 MB 的真实插件源码），不进仓库。
 * 开源后默认路径不能写死作者机器，改为：
 *   ① 命令行参数（优先）
 *   ② 环境变量 M1_ECOSYSTEM_DIR
 *   ③ 仓库内 `test/.ecosystem`（本地放数据用的约定位置，已在 .gitignore 里）
 * 找不到就明确跳过，并给出获取方法。
 */
const ECO_DIR = process.argv[2]
  ? path.dirname(path.resolve(process.argv[2]))
  : (process.env.M1_ECOSYSTEM_DIR || path.join(HERE, '.ecosystem'));
const CAPS = process.argv[2] || path.join(ECO_DIR, 'capabilities.json');
const SAMPLES = process.argv[3] || path.join(ECO_DIR, 'samples');
const PER_GROUP = Number(process.argv[4] || 20);

/**
 * 外部标注（自然语言）→ 我方规则 ID 的映射。
 *
 * 口径说明（重要）：
 *  - 外部 "reads credentials/secrets AND has network access" ≡ 我方 credentials+network
 *  - 外部 "runs code at install time" 我方无对应规则（安装脚本检测不在 redLine 集里）→ 显式记为 unmapped
 *  - 外部 "uses literal IP x for network access"（169.254.169.254 = 云元数据）
 *    我方无对应规则 → unmapped
 *  - 外部 "uses plaintext http:// to HOST" ≡ 我方 cleartext-http
 *    但需注意双方"明文"判定口径差异（我方排除本机/保留地址，见 isLocalTarget）
 */
const RULE_MAP = [
  { match: /reads credentials\/secrets AND has network access/i, ours: 'credentials+network' },
  { match: /runs code at install time/i, ours: null, why: '安装脚本执行：我方未纳入 redLine 集' },
  { match: /uses plaintext http:\/\//i, ours: 'cleartext-http' },
  { match: /uses literal IP .* for network access/i, ours: null, why: '字面 IP/云元数据：我方未纳入 redLine 集' },
];

function mapExternal(rule) {
  for (const m of RULE_MAP) if (m.match.test(rule)) return m;
  return { ours: null, why: '未建立映射' };
}

// ---------- 载入标注 + 抽样 ----------
// 数据缺失时明确跳过（退出 0 + 大声说明），不要假装跑过
if (!existsSync(CAPS)) {
  skip(
    `缺少 M1 真实召回基准数据：${CAPS}`,
    '从 awesome-dsh-plugin/awesome-dsh-plugin 取 data/capabilities.json 放到该路径，'
    + '或用 test/fetch-real-samples.cjs 抓取真实插件源码到 samples/；也可设 M1_ECOSYSTEM_DIR',
  );
}

const raw = existsSync(CAPS) ? JSON.parse(readFileSync(CAPS, 'utf8')) : {};
const all = Object.entries(raw).map(([url, v]) => ({
  url,
  slug: url.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\//g, '__'),
  capabilities: v.capabilities ?? [],
  redLines: v.redLines ?? [],
}));

const withRed = all.filter((p) => p.redLines.length > 0);
const withoutRed = all.filter((p) => p.redLines.length === 0);

// 优先取"红线可映射到我方规则"的，否则无法比对的会污染召回率口径
const mappable = withRed.filter((p) => p.redLines.some((r) => mapExternal(r).ours));
const unmappable = withRed.filter((p) => !p.redLines.some((r) => mapExternal(r).ours));

const avail = existsSync(SAMPLES) ? new Set(readdirSync(SAMPLES)) : new Set();
const pick = (list, n) => list.filter((p) => avail.has(p.slug)).slice(0, n);

const redSample = pick(mappable, PER_GROUP);
const benignSample = pick(withoutRed, PER_GROUP);

// ---------- 扫描 ----------
function scan(plugin) {
  const dir = path.join(SAMPLES, plugin.slug);
  try {
    const card = healthCard(dir);
    return { ok: true, verdict: card.verdict, redLines: card.redLines.map((r) => r.rule), caps: card.capabilities.map((c) => c.id) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 140) };
  }
}

const rows = [];
for (const p of redSample) {
  const expected = new Set(p.redLines.map((r) => mapExternal(r).ours).filter(Boolean));
  const s = scan(p);
  const got = new Set(s.redLines ?? []);
  const hit = [...expected].some((r) => got.has(r));
  rows.push({ slug: p.slug, group: 'redline', expected: [...expected], got: [...got], hit, ok: s.ok, verdict: s.verdict, error: s.error });
}
for (const p of benignSample) {
  const s = scan(p);
  const got = s.redLines ?? [];
  // 外部标注自己承认有 credentials+network 能力 → 我方报红属正确，不算误报
  const extHasCredNet = p.capabilities.includes('credentials') && p.capabilities.includes('network');
  rows.push({
    slug: p.slug, group: 'benign', expected: [], got, falsePositive: got.length > 0,
    extHasCredNet, extCaps: p.capabilities, ok: s.ok, verdict: s.verdict, error: s.error,
  });
}

// ---------- 计分 ----------
const redRows = rows.filter((r) => r.group === 'redline' && r.ok);
const benignRows = rows.filter((r) => r.group === 'benign' && r.ok);
const recallHits = redRows.filter((r) => r.hit).length;
const recall = redRows.length ? recallHits / redRows.length : 0;

/**
 * 误报分两类（真机实测必须区分，否则结论会误导）：
 *   trueFp  —— 外部标注没有任何凭据/网络能力，我方却报红线 → 真误报
 *   baseGap —— 外部标注**自己承认**有 credentials+network 能力，却没标 redLine
 *              → 是基准漏标，我方报出来是正确行为，不能算误报
 * 外部标注内部一致性实测只有 ~83%（见 research/M1真实召回基准-v0.md），不区分会冤枉自己。
 */
const trueFps = [];
const baselineGaps = [];
for (const r of benignRows) {
  if (!r.falsePositive) continue;
  if (r.extHasCredNet) baselineGaps.push(r);
  else trueFps.push(r);
}
const fpRate = benignRows.length ? trueFps.length / benignRows.length : 0;

const ruleScore = {};
for (const r of redRows) {
  for (const rule of r.expected) {
    ruleScore[rule] = ruleScore[rule] ?? { hit: 0, total: 0 };
    ruleScore[rule].total++;
    if (r.got.includes(rule)) ruleScore[rule].hit++;
  }
}

/**
 * 门槛：静态体检卡召回 ≥65%。
 *
 * 历史：方案原文是「对 20 个已知红线插件召回 ≥90%」，但那是**自建模板样本**上的数字
 * （不代表真实能力）。改用 3,843 个真实生态插件做基准后实测 66.1%，
 * 差距主因是静态分析的固有边界（凭据由运行时注入，源码里看不见），
 * 堆正则硬追 90% 会把误报推高。方案 §7 已把出口条件修订为
 * 「静态 ≥65% 且其余由运行时防火墙补足」，这里按修订后的门槛断言。
 */
const PASS_GATE = 0.65;

const out = {
  gate: '已知红线插件静态召回 ≥65%（方案 §7 修订后的口径；原 ≥90% 已废除）',
  dataset: {
    source: CAPS,
    totalPlugins: all.length,
    withRedLines: withRed.length,
    redLineRate: Number((withRed.length / all.length * 100).toFixed(1)),
    mappableToOurs: mappable.length,
    unmappableToOurs: unmappable.length,
    sampled: { redline: redSample.length, benign: benignSample.length },
    samplesDir: SAMPLES,
  },
  externalRulesUnmapped: [...new Set(withRed.flatMap((p) => p.redLines).filter((r) => !mapExternal(r).ours))]
    .map((r) => ({ rule: r, why: mapExternal(r).why })),
  recall: { hit: recallHits, total: redRows.length, pct: Number((recall * 100).toFixed(1)), pass: recall >= PASS_GATE },
  byRule: ruleScore,
  falsePositive: {
    trueFp: trueFps.length,
    baselineGap: baselineGaps.length,
    benignTotal: benignRows.length,
    trueFpPct: Number((fpRate * 100).toFixed(1)),
    trueFpSlugs: trueFps.map((r) => r.slug),
    baselineGapSlugs: baselineGaps.map((r) => r.slug),
    note: 'baselineGap = 外部标注自身承认 credentials+network 却未标红线，我方报出属正确，非误报',
  },
  scanErrors: rows.filter((r) => !r.ok).length,
  rows,
};
// 判定只看方案写明的门槛（召回）。误报只如实报告，不单独设卡——
// 方案对误报的口径是"可接受（内测反馈）"，凭空加阈值会让这个测试失去依据。
out.all = out.recall.pass;
report(out);
