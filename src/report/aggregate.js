/**
 * 多源汇总 —— M3「企业特性」之多 profile / 多机汇总
 *
 * 为什么需要：默认所有 profile 共享 `<DSH_HOME>/firewall`，但真实企业场景里
 * 可能是「多个 DSH_HOME / 多台机器 / 多份归档」各自落了一份 events.jsonl，
 * 安全团队要的是一份**跨源**的结论，而不是逐台打开看。
 *
 * 设计约束（避免汇总本身变成一个新的不可信来源）：
 *   ① **每条事件保留来源标签**：汇总结果里任何数字都能追回到某个文件，
 *      不允许出现"来源不明的事件被算进总数"；
 *   ② **坏行不静默丢弃**：解析失败的行计数并报告（否则汇总会系统性偏低）；
 *   ③ **轮转文件一并读**：events.jsonl.1/.2/.3 是历史，漏读等于截断时间线；
 *   ④ **去重口径必须写明**：同一事件可能因轮转/复制出现在两个文件里，
 *      按 (t, actor, api, target) 去重，并报告去掉了多少条。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FILES = 4; // events.jsonl + .1/.2/.3

/**
 * 列出一个数据目录下的事件文件（含轮转历史）。
 * @returns {{eventFiles: string[], otherFiles: string[]}}
 */
export function discoverEventFiles(dataDir, { maxRotated = 3 } = {}) {
  const eventFiles = [];
  const otherFiles = [];
  let entries;
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }); } catch { return { eventFiles, otherFiles }; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(dataDir, ent.name);
    if (/^events\.jsonl(\.\d+)?$/.test(ent.name)) {
      const n = ent.name === 'events.jsonl' ? 0 : Number(ent.name.split('.').pop());
      if (n <= maxRotated) eventFiles.push({ file: full, order: n });
    } else if (/\.jsonl$/.test(ent.name)) {
      otherFiles.push(full);
    }
  }
  // 旧 → 新：.3, .2, .1, 当前
  eventFiles.sort((a, b) => b.order - a.order);
  return { eventFiles: eventFiles.map((e) => e.file), otherFiles };
}

/** 读一个 events.jsonl（或其轮转副本），返回 {events, badLines, bytes} */
export function readEventFile(file, { sourceLabel = null } = {}) {
  const events = [];
  let badLines = 0;
  let bytes = 0;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    bytes = Buffer.byteLength(text, 'utf8');
  } catch {
    return { events, badLines: 0, bytes: 0, unreadable: true, sourceLabel };
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e !== 'object') { badLines++; continue; }
      if (sourceLabel) e.__source = sourceLabel;
      events.push(e);
    } catch { badLines++; }
  }
  return { events, badLines, bytes, sourceLabel };
}

/**
 * 汇总多个源。
 *
 * @param {Array<{label: string, dir: string} | string>} sources
 * @param {object} [opts]
 * @param {boolean} [opts.dedupe] 默认 true：按 (t, actor, api, target) 去重
 * @param {number} [opts.maxRotated] 每个目录读几份轮转档
 */
export function aggregateSources(sources, opts = {}) {
  const dedupe = opts.dedupe !== false;
  const maxRotated = opts.maxRotated ?? 3;
  const normalized = sources.map((s) => (typeof s === 'string' ? { label: s, dir: s } : s));

  const seen = new Set();
  const perSource = [];
  const allEvents = [];
  let duplicateDropped = 0;
  let badLines = 0;
  let totalBytes = 0;

  for (const src of normalized) {
    const { eventFiles, otherFiles } = discoverEventFiles(src.dir, { maxRotated });
    let srcEvents = 0;
    let srcBad = 0;
    let srcBytes = 0;
    const files = [];
    for (const f of eventFiles) {
      const rel = `${src.label}/${path.basename(f)}`;
      const r = readEventFile(f, { sourceLabel: rel });
      files.push({ file: rel, events: r.events.length, badLines: r.badLines, bytes: r.bytes, unreadable: !!r.unreadable });
      srcBad += r.badLines;
      srcBytes += r.bytes;
      for (const e of r.events) {
        if (dedupe) {
          const fp = `${e.t}\u0000${e.actor}\u0000${e.api}\u0000${e.target}`;
          if (seen.has(fp)) { duplicateDropped++; continue; }
          seen.add(fp);
        }
        allEvents.push(e);
        srcEvents++;
      }
    }
    badLines += srcBad;
    totalBytes += srcBytes;
    perSource.push({
      label: src.label,
      dir: src.dir,
      exists: fs.existsSync(src.dir),
      eventFiles: files,
      otherFiles: otherFiles.map((f) => path.basename(f)),
      events: srcEvents,
      badLines: srcBad,
      bytes: srcBytes,
    });
  }

  return {
    schema: 'dsh-pdr/aggregate@1',
    generatedAt: new Date().toISOString(),
    options: { dedupe, maxRotated },
    sources: perSource,
    totals: {
      sources: normalized.length,
      eventFiles: perSource.reduce((n, s) => n + s.eventFiles.length, 0),
      events: allEvents.length,
      duplicateDropped,
      badLines,
      bytes: totalBytes,
    },
    events: allEvents,
  };
}

/** 事件 → 按 actor 的行为画像（汇总报告的主体） */
export function profileByActor(events, { topTargets = 5 } = {}) {
  const byActor = new Map();
  for (const e of events) {
    const actor = e.actor || 'unknown';
    let a = byActor.get(actor);
    if (!a) {
      a = {
        actor, events: 0, sources: new Set(), apis: new Map(), flags: new Map(),
        redLines: new Map(), firstSeen: e.t, lastSeen: e.t, targets: new Map(),
      };
      byActor.set(actor, a);
    }
    a.events++;
    if (e.__source) a.sources.add(e.__source);
    if (e.t < a.firstSeen) a.firstSeen = e.t;
    if (e.t > a.lastSeen) a.lastSeen = e.t;
    a.apis.set(e.api, (a.apis.get(e.api) || 0) + 1);
    for (const f of e.flags ?? []) a.flags.set(f, (a.flags.get(f) || 0) + 1);
    for (const r of e.redLines ?? (e.redLine ? [e.redLine] : [])) a.redLines.set(r, (a.redLines.get(r) || 0) + 1);
    if (e.target) a.targets.set(String(e.target).slice(0, 160), (a.targets.get(String(e.target).slice(0, 160)) || 0) + 1);
  }

  const top = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));

  return [...byActor.values()]
    .map((a) => ({
      actor: a.actor,
      events: a.events,
      sources: [...a.sources].sort(),
      firstSeen: new Date(a.firstSeen).toISOString(),
      lastSeen: new Date(a.lastSeen).toISOString(),
      apis: top(a.apis, 8),
      flags: top(a.flags, 8),
      redLines: top(a.redLines, 8),
      topTargets: top(a.targets, topTargets),
    }))
    .sort((x, y) => y.events - x.events);
}

/** 跨源红线汇总：同一插件在多个源都触发同一条规则时合并计数 */
export function redLineSummary(events) {
  const m = new Map();
  for (const e of events) {
    const rules = e.redLines ?? (e.redLine ? [e.redLine] : []);
    for (const rule of rules) {
      const key = `${e.actor}\u0000${rule}`;
      let r = m.get(key);
      if (!r) { r = { actor: e.actor, rule, count: 0, sources: new Set(), lastAt: e.t, lastTarget: e.target ?? null }; m.set(key, r); }
      r.count++;
      if (e.__source) r.sources.add(e.__source);
      if (e.t > r.lastAt) { r.lastAt = e.t; r.lastTarget = e.target ?? null; }
    }
  }
  return [...m.values()]
    .map((r) => ({ ...r, sources: [...r.sources].sort(), lastAt: new Date(r.lastAt).toISOString() }))
    .sort((x, y) => y.count - x.count);
}

/** 人读 Markdown 汇总（安全周报用） */
export function aggregateMarkdown(agg) {
  const actors = profileByActor(agg.events);
  const reds = redLineSummary(agg.events);
  const t = agg.totals;
  const lines = [
    '# DSH-PDR-Plugin 多源汇总报告',
    '',
    `> 生成时间：${agg.generatedAt}`,
    `> 数据仅来自本机/本报告列出的来源，未上传任何遥测。`,
    '',
    '## 汇总概览',
    `- 数据源：${t.sources}`,
    `- 事件文件：${t.eventFiles}`,
    `- 事件总数：${t.events}${t.duplicateDropped ? `（去重 ${t.duplicateDropped} 条）` : ''}`,
    `- 解析失败行：${t.badLines}${t.badLines > 0 ? ' ⚠️ 数据可能不完整' : ''}`,
    '',
    '## 数据源明细',
    '| 来源 | 事件 | 坏行 | 文件 |',
    '|---|---|---|---|',
    ...agg.sources.map((s) => `| ${s.label} | ${s.events} | ${s.badLines} | ${s.eventFiles.map((f) => `${path.basename(f.file)}(${f.events})`).join(' ') || '-'} |`),
    '',
    '## 跨源红线',
    ...(reds.length
      ? ['| 插件 | 规则 | 次数 | 来源 | 最近目标 |', '|---|---|---|---|---|',
        ...reds.map((r) => `| ${r.actor} | ${r.rule} | ${r.count} | ${r.sources.length} | ${r.lastTarget ?? '-'} |`)]
      : ['- 无']),
    '',
    '## 插件行为画像（按事件数）',
    '| 插件 | 事件 | 来源数 | 红线 | 首见 | 末见 |',
    '|---|---|---|---|---|---|',
    ...actors.slice(0, 50).map((a) =>
      `| ${a.actor} | ${a.events} | ${a.sources.length} | ${a.redLines.map((x) => x.key).join('/') || '-'} | ${a.firstSeen} | ${a.lastSeen} |`),
  ];
  return lines.join('\n');
}
