/**
 * 越界判定层评测：场景矩阵 × 期望违规
 *
 * 硬指标：
 *  ① 本职行为零打扰：桥接插件干正事（读自己 token + 连声明 API + 起子进程）违规数 = 0
 *  ② 越界检出：敏感目标 / 出范围外联 / 能力面 / 跨插件 / 基线偏移 全部按期望触发
 *  ③ 分级正确：正常/观察/可疑/越界 与场景性质一致
 *
 * 用法：node test/judge-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Judge, VERDICT } from '../src/judge/judge.js';
import { deriveContract } from '../src/judge/contract.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-judge-'));
const DIR_A = path.join(TMP, 'trae-bridge');
const DIR_B = path.join(TMP, 'ui-plugin');
const DIR_C = path.join(TMP, 'other-plug');
for (const d of [DIR_A, DIR_B, DIR_C]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'x.js'), ''); }

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const now = Date.now();
const at3am = (() => { const d = new Date(); d.setHours(3, 0, 0, 0); return d.getTime(); })();

const ev = (actor, api, target, t = now) => ({ t, actor, api, target, flags: [] });

function makeJudge(opts = {}) {
  const j = new Judge({ baselineOpts: opts.baselineOpts ?? {} });
  j.registerPlugin('trae-bridge', DIR_A);
  j.registerPlugin('ui-plugin', DIR_B);
  j.registerPlugin('other-plug', DIR_C);
  // 桥接契约：凭据+网络+shell 是本职，声明了自家 API
  j.setContract('trae-bridge', deriveContract({
    name: 'trae-bridge', dir: DIR_A,
    capabilities: ['network', 'fs-read', 'fs-write', 'credentials', 'shell', 'env'],
    manifest: { firewall: { hosts: ['api.trae.example'] } },
  }));
  // UI 插件契约：只该碰本地文件
  j.setContract('ui-plugin', deriveContract({ name: 'ui-plugin', dir: DIR_B, capabilities: ['fs-read', 'fs-write'] }));
  return j;
}

const results = [];
const check = (id, label, expectRules, expectVerdict, violations, judgeVerdict) => {
  const rules = [...new Set(violations.map((v) => v.rule))];
  const rulesOk = expectRules.every((r) => rules.includes(r)) && rules.length === expectRules.length;
  const verdictOk = judgeVerdict === expectVerdict;
  results.push({ id, label, expectRules, observedRules: rules, expectVerdict, observedVerdict: judgeVerdict, pass: rulesOk && verdictOk });
};

// ---------- A. 桥接正职：零打扰 ----------
{
  const j = makeJudge();
  let v = [];
  v = v.concat(j.observe(ev('trae-bridge', 'fs.readFileSync', path.join(DIR_A, 'token.json'))));
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'https://api.trae.example/poll')));
  v = v.concat(j.observe(ev('trae-bridge', 'child_process.exec', 'node helper.js')));
  v = v.concat(j.observe(ev('trae-bridge', 'fs.promises.writeFile', path.join(DIR_A, 'cache', 'c.json'))));
  check('A', '桥接正职（自家 token/声明 API/子进程/自家缓存）', [], 'normal', v, j.getVerdict('trae-bridge').verdict);
}

// ---------- B. 桥接越界：碰全局凭据 + 出范围外联 + 红线升级 ----------
{
  const j = makeJudge();
  let v = [];
  v = v.concat(j.observe(ev('trae-bridge', 'fs.readFileSync', CRED)));
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'http://203.0.113.7/p')));
  j.observeRedFlag({ rule: 'credentials+network', actor: 'trae-bridge', t: now });
  check('B', '桥接越界（全局凭据 + 出范围外联 + 红线升级）',
    ['target-sensitive', 'exfil-out-of-scope'], 'boundary', v, j.getVerdict('trae-bridge').verdict);
}

// ---------- C. 能力面越界：声明无网络却联网 ----------
{
  const j = makeJudge();
  let v = [];
  v = v.concat(j.observe(ev('ui-plugin', 'fs.readFileSync', path.join(DIR_B, 'theme.json'))));
  v = v.concat(j.observe(ev('ui-plugin', 'fetch', 'https://collector.example.net/x')));
  check('C', '能力面越界（无 network 能力却联网）', ['capability-deviation'], 'suspicious', v, j.getVerdict('ui-plugin').verdict);
}

// ---------- D. 基线偏移：学习期后 凌晨 + 新目的地（无声明 hosts，纯测基线） ----------
{
  const j = makeJudge({ baselineOpts: { learningEvents: 3 } });
  j.setContract('trae-bridge', deriveContract({ name: 'trae-bridge', dir: DIR_A, capabilities: ['network', 'fs-read'] }));
  let v = [];
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'https://api.trae.example/poll', now - 3600_000)));
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'https://api.trae.example/poll', now - 3500_000)));
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'https://api.trae.example/poll', now - 3400_000)));
  v = v.concat(j.observe(ev('trae-bridge', 'fetch', 'https://unknown-place.example.net/x', at3am)));
  check('D', '基线偏移（学习期后凌晨新目的地）',
    ['baseline-new-destination', 'baseline-odd-hour'], 'observe', v, j.getVerdict('trae-bridge').verdict);
}

// ---------- E. 跨插件目标：碰别人插件的文件 ----------
{
  const j = makeJudge();
  const v = j.observe(ev('ui-plugin', 'fs.readFileSync', path.join(DIR_C, 'secret-state.json')));
  check('E', '跨插件目标（读其他插件的文件）', ['target-other-plugin'], 'suspicious', v, j.getVerdict('ui-plugin').verdict);
}

// ---------- F. 良性本地插件：零打扰 ----------
{
  const j = makeJudge();
  let v = [];
  v = v.concat(j.observe(ev('ui-plugin', 'fs.readFileSync', path.join(DIR_B, 'a.json'))));
  v = v.concat(j.observe(ev('ui-plugin', 'fs.promises.writeFile', path.join(DIR_B, 'b.json'))));
  v = v.concat(j.observe(ev('ui-plugin', 'fs.writeFileSync', path.join(tmpdir(), 'fw-x', 't.json'))));
  check('F', '良性本地插件（自有目录 + 临时目录）', [], 'normal', v, j.getVerdict('ui-plugin').verdict);
}

// ---------- 计分 ----------
const inScope = results.filter((r) => ['A', 'F'].includes(r.id));
const detected = results.filter((r) => !['A', 'F'].includes(r.id));
const metrics = {
  inScopeFalsePositive: { fp: inScope.filter((r) => !r.pass).length, total: inScope.length },
  detection: { hit: detected.filter((r) => r.pass).length, total: detected.length },
  all: results.every((r) => r.pass),
};
rmSync(TMP, { recursive: true, force: true });
report({ metrics, results });
