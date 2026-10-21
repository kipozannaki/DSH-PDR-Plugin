/**
 * 契约推断助手 —— "它该干什么"的冷启动方案
 *
 * 从行为迹（学习窗口的事件流）推断契约草案，供用户确认：
 *   declaredHosts ← 稳定复现且"清白"的目的地（≥2 次出现，且不在凭据触碰的嫌疑窗口内）
 *   capabilities  ← 体检卡声明面 ∪ 实际用过的 API 类别（声明 + 实测的并集）
 *   grants        ← 永不自动授予（敏感目标授权必须人工点头）
 *
 * 铁律：**推断不赦免红线现场**
 *   - 伴随凭据触碰出现的目的地不进白名单，进 needsReview（附证据）
 *   - 敏感路径触碰只记录为证据，绝不写进 grants
 *   ——否则"观察一周就能把恶意行为学成本职"，推断就成了洗白机。
 */
import { classifyPath, hostOf } from './paths.js';

const WINDOW_MS = 5 * 60_000;     // 凭据触碰的嫌疑窗口
const MIN_HOST_SIGHTINGS = 2;     // 进白名单的最低出现次数

function apiToCaps(api) {
  const a = String(api);
  if (/^fetch|^https?:|^net\.|^(http|https)\./.test(a)) return ['network'];
  if (a.startsWith('child_process')) return ['shell'];
  if (a.startsWith('fs')) {
    return /write|append|rm|unlink|rename|mkdir|open/i.test(a) ? ['fs-read', 'fs-write'] : ['fs-read'];
  }
  return [];
}

/** 判定词表（与 contract.capabilities 同语） */
function apiClassOf(api) {
  const a = String(api);
  if (/^fetch|^https?:|^net\.|^(http|https)\./.test(a)) return 'network';
  if (a.startsWith('child_process')) return 'shell';
  if (a.startsWith('fs')) return 'fs';
  return 'other';
}

export function inferContract({ name, events = [], capabilities = [], ownDirs = [], pluginDirs = new Map() }) {
  const sorted = [...events].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const hosts = new Map(); // host -> { count, firstT, lastT, tainted, reason }
  const apiClasses = new Set(); // 判定词表：network/shell/fs
  const detailCaps = new Set(); // 细粒度能力：fs-read/fs-write/…
  const pathClasses = new Set();
  const sensitiveTouches = [];
  const redlineFlags = [];

  // 凭据触碰时间点（所有，用于嫌疑窗口）
  const credTimes = sorted
    .filter((e) => e.flags?.includes('credentials-access'))
    .map((e) => e.t ?? 0);

  for (const e of sorted) {
    for (const cap of apiToCaps(e.api)) detailCaps.add(cap);
    apiClasses.add(apiClassOf(e.api));

    const host = hostOf(e.target);
    if (host && /^fetch|^https?:|^net\.|^(http|https)\./.test(String(e.api))) {
      const t = e.t ?? 0;
      const nearCred = credTimes.some((ct) => Math.abs(ct - t) <= WINDOW_MS);
      const row = hosts.get(host) ?? { count: 0, firstT: t, lastT: t, tainted: false, reason: '' };
      row.count++;
      row.lastT = t;
      if (nearCred && !row.tainted) {
        row.tainted = true;
        row.reason = '出现在凭据触碰的嫌疑窗口内（±5min）';
      }
      hosts.set(host, row);
    }

    if (String(e.api).startsWith('fs')) {
      const info = classifyPath(e.target, { ownDirs, pluginDirs });
      pathClasses.add(info.class);
      if (info.class === 'sensitive') {
        sensitiveTouches.push({ t: e.t, target: String(e.target).slice(0, 120) });
      }
    }
    const rules = Array.isArray(e.redLines) ? e.redLines : (e.redLine ? [e.redLine] : []);
    for (const r of rules) redlineFlags.push(r);
    for (const f of e.flags ?? []) {
      if (f === 'cleartext-http') redlineFlags.push('cleartext-http');
    }
  }

  // 白名单：清白 + 稳定复现；被污染的进排除清单
  const declaredHosts = [];
  const hostsExcluded = [];
  for (const [host, row] of hosts) {
    if (row.tainted) hostsExcluded.push({ host, sightings: row.count, reason: row.reason });
    else if (row.count >= MIN_HOST_SIGHTINGS) declaredHosts.push(host);
    else hostsExcluded.push({ host, sightings: row.count, reason: `仅出现 ${row.count} 次（稳定目的地需 ≥${MIN_HOST_SIGHTINGS} 次），留观` });
  }

  const needsReview = [];
  if (sensitiveTouches.length) {
    needsReview.push(`观察到 ${sensitiveTouches.length} 次全局凭据/密钥类路径触碰（未自动授权，需人工确认是否本职）`);
  }
  for (const x of hostsExcluded) {
    if (x.reason.includes('嫌疑窗口')) needsReview.push(`目的地 ${x.host} ${x.reason}，未列入白名单`);
  }
  if (redlineFlags.length) {
    needsReview.push(`行为迹中出现红线信号：${[...new Set(redlineFlags)].join(' / ')}`);
  }

  return {
    name,
    source: 'inferred',
    scope: 'closed', // 推断即封闭：白名单外的目的地一律违规（推断不赦免红线现场）
    capabilities: [...apiClasses].filter((c) => c !== 'other'), // 判定词表
    declaredCapabilities: [...new Set([...capabilities, ...detailCaps])], // 细粒度（展示用）
    declaredHosts: declaredHosts.sort(),
    grants: [], // 铁律：永不自动授予
    evidence: {
      eventCount: sorted.length,
      window: sorted.length ? { from: sorted[0].t, to: sorted[sorted.length - 1].t } : null,
      hostsSeen: [...hosts.keys()],
      hostsExcluded,
      pathClasses: [...pathClasses],
      apiClasses: [...apiClasses],
      sensitiveTouches: sensitiveTouches.slice(0, 10),
    },
    needsReview,
  };
}
