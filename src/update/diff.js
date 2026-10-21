/**
 * 更新 diff —— 方案 §4.1③："这次更新新增了 network 能力"
 *
 * 对比一个插件两个版本的**能力面 / 红线 / bundle patch 条目 / 依赖**，
 * 回答用户故事 3："更新后炸了怎么办？先告诉我这次更新改了什么"。
 *
 * 关键输出 contractImpact：能力面变宽（broader）= 契约需要重新确认——
 * 这是"更新守护"与"越界判定"的连接点：能力面变宽的更新应当触发契约复审。
 */
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { healthCard } from '../inspector/health-card.js';

/** 抓取一个版本的"指纹"：manifest 关键项 + 体检卡 */
export function captureVersion(dir) {
  const card = healthCard(dir);
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch { /* 无 manifest 时只用卡片 */ }
  return {
    name: manifest.name ?? card.name ?? path.basename(dir),
    version: manifest.version ?? '',
    dependencies: Object.keys(manifest.dependencies ?? {}),
    capabilities: (card.capabilities ?? []).map((c) => c.id).sort(),
    redLines: (card.redLines ?? []).map((r) => r.rule).sort(),
    patchEntries: (card.patchEntries ?? []).slice().sort(),
    verdict: card.verdict ?? 'PASS',
  };
}

function diffSet(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((x) => !b.has(x)),
    removed: [...b].filter((x) => !a.has(x)),
  };
}

/** 对比两版本，返回结构化 diff + 人读摘要 */
export function diffVersions(before, after) {
  const capabilities = diffSet(before.capabilities, after.capabilities);
  const redLines = diffSet(before.redLines, after.redLines);
  const patchEntries = diffSet(before.patchEntries, after.patchEntries);
  const dependencies = diffSet(before.dependencies, after.dependencies);

  // 契约影响：能力面变宽/收窄/不变（连接越界判定层）
  const contractImpact = capabilities.added.length ? 'broader'
    : capabilities.removed.length ? 'narrower' : 'same';

  const verdictChange = { before: before.verdict, after: after.verdict };
  const verdictWorse = rank(after.verdict) > rank(before.verdict);

  const summary = buildSummary({ capabilities, redLines, patchEntries, dependencies, contractImpact, verdictChange, verdictWorse });

  return {
    name: after.name,
    version: { before: before.version, after: after.version },
    capabilities, redLines, patchEntries, dependencies,
    contractImpact, verdictChange, verdictWorse, summary,
  };
}

/** 便捷入口：直接给两个目录 */
export function diffDirs(beforeDir, afterDir) {
  return diffVersions(captureVersion(beforeDir), captureVersion(afterDir));
}

function rank(verdict) {
  return { PASS: 0, WARN: 1, BLOCK: 2 }[verdict] ?? 0;
}

function buildSummary(d) {
  const parts = [];
  for (const c of d.capabilities.added) parts.push(`新增 ${c} 能力`);
  for (const c of d.capabilities.removed) parts.push(`移除 ${c} 能力`);
  for (const r of d.redLines.added) parts.push(`新增红线 ${r}`);
  for (const r of d.redLines.removed) parts.push(`移除红线 ${r}`);
  if (d.patchEntries.added.length) parts.push(`新增插件条目 ${d.patchEntries.added.join('/')}`);
  if (d.patchEntries.removed.length) parts.push(`移除插件条目 ${d.patchEntries.removed.join('/')}`);
  if (d.dependencies.added.length) parts.push(`新增依赖 ${d.dependencies.added.slice(0, 5).join('/')}`);
  if (d.dependencies.removed.length) parts.push(`移除依赖 ${d.dependencies.removed.slice(0, 5).join('/')}`);
  if (d.verdictWorse) parts.push(`判定降级 ${d.verdictChange.before}→${d.verdictChange.after}`);
  if (d.contractImpact === 'broader') parts.push('⚠ 能力面变宽 → 建议复审契约');
  return parts.length ? parts.join('；') : '无实质变化';
}
