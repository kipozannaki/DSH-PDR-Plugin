/**
 * 契约推断评测：四个硬性质
 *  ① 自洽性：推断契约重放同一行为迹 → 零违规（推断出的"本职"确实覆盖观察到的本职）
 *  ② 不赦免红线现场：伴随凭据触碰的目的地不进白名单，重放仍判违规（越界不被洗白）
 *  ③ 敏感授权永不自动：grants 恒空，敏感触碰进 needsReview
 *  ④ 存储优先级：草案未确认不生效；adopt 后生效；用户覆盖最高；持久化 roundtrip
 *
 * 用法：node test/contract-infer-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Judge } from '../src/judge/judge.js';
import { inferContract } from '../src/judge/infer.js';
import { ContractStore } from '../src/judge/contract-store.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-infer-'));
const DIR_A = path.join(TMP, 'trae-bridge');
const DIR_B = path.join(TMP, 'ui-plugin');
for (const d of [DIR_A, DIR_B]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'x.js'), ''); }

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const now = Date.now();
const ev = (actor, api, target, flags = [], t = now) => ({ t, actor, api, target, flags });

const results = [];
const assert = (id, label, cond, detail) => results.push({ id, label, pass: !!cond, detail });

function replay(j, trace) {
  const violations = [];
  for (const e of trace) violations.push(...j.observe(e));
  return violations;
}

// ---------- ① 桥接正职：自洽 ----------
const traceA = [
  ev('trae-bridge', 'fs.readFileSync', path.join(DIR_A, 'token.json')),
  ev('trae-bridge', 'fetch', 'https://api.trae.example/poll', [], now - 2000),
  ev('trae-bridge', 'fetch', 'https://api.trae.example/poll', [], now - 1000),
  ev('trae-bridge', 'child_process.exec', 'node helper.js'),
  ev('trae-bridge', 'fs.promises.writeFile', path.join(DIR_A, 'cache.json')),
];
{
  const draft = inferContract({
    name: 'trae-bridge', events: traceA,
    capabilities: ['network', 'fs-read', 'fs-write', 'credentials', 'shell'],
    ownDirs: [DIR_A], pluginDirs: new Map([[DIR_A, 'trae-bridge']]),
  });
  assert('A1', '正职目的地进白名单', draft.declaredHosts.includes('api.trae.example'), JSON.stringify(draft.declaredHosts));
  assert('A2', '无红线现场 → 无 review 项', draft.needsReview.length === 0, JSON.stringify(draft.needsReview));
  assert('A3', 'grants 恒空', draft.grants.length === 0);

  const j = new Judge({});
  j.registerPlugin('trae-bridge', DIR_A);
  j.setContract('trae-bridge', draft);
  const v = replay(j, traceA);
  assert('A4', '自洽性：同一行为迹零违规', v.length === 0, JSON.stringify(v.map((x) => x.rule)));
}

// ---------- ② 红线现场：不赦免 ----------
const traceB = [
  ev('trae-bridge', 'fs.readFileSync', CRED, ['credentials-access'], now - 1000),
  ev('trae-bridge', 'fetch', 'http://203.0.113.7/p', ['cleartext-http']),
];
{
  const draft = inferContract({
    name: 'trae-bridge', events: traceB,
    capabilities: ['network', 'fs-read', 'credentials'],
    ownDirs: [DIR_A], pluginDirs: new Map([[DIR_A, 'trae-bridge']]),
  });
  assert('B1', '嫌疑目的地不进白名单', !draft.declaredHosts.includes('203.0.113.7'), JSON.stringify(draft.declaredHosts));
  assert('B2', '排除清单记录嫌疑原因', draft.evidence.hostsExcluded.some((x) => x.host === '203.0.113.7' && x.reason.includes('嫌疑窗口')), JSON.stringify(draft.evidence.hostsExcluded));
  assert('B3', 'grants 恒空（敏感触碰不自动授权）', draft.grants.length === 0 && draft.needsReview.some((s) => s.includes('凭据')), JSON.stringify(draft.needsReview));

  const j = new Judge({});
  j.registerPlugin('trae-bridge', DIR_A);
  j.setContract('trae-bridge', draft);
  const v = replay(j, traceB);
  const rules = v.map((x) => x.rule);
  assert('B4', '未赦免：重放仍判目标越界', rules.includes('target-sensitive'), JSON.stringify(rules));
  assert('B5', '未赦免：重放仍判目的地越界（scope 封闭）', rules.includes('destination-scope'), JSON.stringify(rules));
}

// ---------- ③ 纯本地插件 ----------
const traceC = [
  ev('ui-plugin', 'fs.readFileSync', path.join(DIR_B, 'theme.json')),
  ev('ui-plugin', 'fs.promises.writeFile', path.join(DIR_B, 'state.json')),
];
{
  const draft = inferContract({ name: 'ui-plugin', events: traceC, capabilities: ['fs-read', 'fs-write'], ownDirs: [DIR_B], pluginDirs: new Map([[DIR_B, 'ui-plugin']]) });
  assert('C1', '本地插件无外联白名单且封闭', draft.declaredHosts.length === 0 && draft.scope === 'closed');
  const j = new Judge({});
  j.registerPlugin('ui-plugin', DIR_B);
  j.setContract('ui-plugin', draft);
  const v = replay(j, traceC);
  assert('C2', '自洽性：本地行为零违规', v.length === 0, JSON.stringify(v.map((x) => x.rule)));
  // 封闭语义验证：突然联网 = 违规
  const v2 = j.observe(ev('ui-plugin', 'fetch', 'https://collector.example.net/x'));
  assert('C3', '封闭契约：未见过的外联判违规', v2.some((x) => x.rule === 'capability-deviation' || x.rule === 'destination-scope'), JSON.stringify(v2.map((x) => x.rule)));
}

// ---------- ④ 存储优先级与持久化 ----------
{
  const file = path.join(TMP, 'contracts.json');
  const store = new ContractStore(file);
  store.setDraft('trae-bridge', { name: 'trae-bridge', declaredHosts: ['api.trae.example'], grants: [], scope: 'closed' });
  assert('D1', '草案未确认不生效', store.get('trae-bridge') === null);

  const adopted = store.adopt('trae-bridge');
  assert('D2', 'adopt 后生效且标注来源', store.get('trae-bridge')?.source === 'user-adopted', adopted?.source);

  store.setOverride('trae-bridge', { name: 'trae-bridge', declaredHosts: ['api.trae.example', 'extra.example.com'], grants: [] });
  assert('D3', '用户覆盖优先于草案', store.get('trae-bridge').declaredHosts.includes('extra.example.com'));

  const reloaded = new ContractStore(file);
  assert('D4', '持久化 roundtrip', reloaded.get('trae-bridge')?.declaredHosts?.includes('extra.example.com'));
}

rmSync(TMP, { recursive: true, force: true });
const metrics = { all: results.every((r) => r.pass), passed: results.filter((r) => r.pass).length, total: results.length };
report({ metrics, results });
