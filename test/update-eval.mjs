/**
 * M2 更新守护评测：更新 diff + 隔离试装
 *
 * 硬指标：
 *  ① diff：能力面/红线/patch/依赖变化正确识别，能力面变宽 = broader（触发契约复审）
 *  ② 试装门禁：好插件 PASS、加载失败/崩溃/挂起 FAIL
 *  ③ 隔离：崩溃与挂起都关在子进程，父进程（真宿主隐喻）安然无恙
 *
 * 用法：node test/update-eval.mjs
 */
import path from 'node:path';
import { report } from './_report.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { diffDirs } from '../src/update/diff.js';
import { trialInstall } from '../src/update/trial.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-update-'));
const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

function writePlugin(dir, { manifest = {}, code = '', patch = '' }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', main: 'index.mjs', ...manifest }, null, 2));
  writeFileSync(path.join(dir, 'index.mjs'), code);
  if (patch) writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
}

// ================= 更新 diff =================
const BEFORE = path.join(TMP, 'before');
const AFTER = path.join(TMP, 'after');

// before：只有本地 fs，PASS
writePlugin(BEFORE, {
  manifest: { version: '1.0.0', dependencies: { lodash: '1.0.0' } },
  code: `import fs from 'node:fs';\nfs.readFileSync('a', 'utf8');\n`,
});

// after：新增 network + credentials 能力 + credentials+network 红线，判定降级
writePlugin(AFTER, {
  manifest: { version: '2.0.0', dependencies: { lodash: '1.0.0', axios: '1.0.0' } },
  code: `import fs from 'node:fs';\nfs.readFileSync('a', 'utf8');\nfetch('https://api.x.com');\napi_key = 'abc';\n`,
  patch: `- insert:\n    - id: new-entry\n      name: demo\n`,
});

{
  const d = diffDirs(BEFORE, AFTER);
  check('D1', '能力面新增 network/credentials', d.capabilities.added.includes('network') && d.capabilities.added.includes('credentials'), JSON.stringify(d.capabilities));
  check('D2', '新增红线 credentials+network', d.redLines.added.includes('credentials+network'), JSON.stringify(d.redLines));
  check('D3', '能力面变宽 → contractImpact=broader', d.contractImpact === 'broader', d.contractImpact);
  check('D4', 'patch 条目新增 new-entry', d.patchEntries.added.includes('new-entry'), JSON.stringify(d.patchEntries));
  check('D5', '依赖新增 axios', d.dependencies.added.includes('axios'), JSON.stringify(d.dependencies));
  check('D6', '判定降级 detected', d.verdictWorse === true && d.verdictChange.before !== d.verdictChange.after, JSON.stringify(d.verdictChange));
  check('D7', '人读摘要含"新增 network 能力"', d.summary.includes('新增 network 能力') && d.summary.includes('能力面变宽'), d.summary);
}

// 无变化对照
{
  const same = diffDirs(BEFORE, BEFORE);
  check('D8', '无变化 → same + 无实质变化', same.contractImpact === 'same' && same.summary === '无实质变化', same.summary);
}

// ================= 隔离试装 =================
const T = (name) => path.join(TMP, 'trial-' + name);

// T1 好插件
writePlugin(T('good'), { manifest: { name: 'trial-good' }, code: `export default function (ctx, config) { return {}; }\n` });
// T2 加载即抛
writePlugin(T('throws'), { manifest: { name: 'trial-throws' }, code: `throw new Error('import boom');\n` });
// T3 插件调 process.exit（进程崩溃）
writePlugin(T('exits'), { manifest: { name: 'trial-exits' }, code: `process.exit(3);\n` });
// T4 挂起（同步阻塞 60s，不烧 CPU）
writePlugin(T('hangs'), { manifest: { name: 'trial-hangs' }, code: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\nexport default function () {};\n` });

{
  const r = trialInstall({ pluginDir: T('good'), timeoutMs: 12000 });
  check('T1', '好插件试装通过 PASS', r.verdict === 'PASS' && r.isolated === true, `${r.verdict}: ${r.reason}`);
}
{
  const r = trialInstall({ pluginDir: T('throws'), timeoutMs: 12000 });
  check('T2', '加载即抛 → FAIL', r.verdict === 'FAIL', `${r.verdict}: ${r.reason}`);
}
{
  const r = trialInstall({ pluginDir: T('exits'), timeoutMs: 12000 });
  check('T3', 'process.exit 崩溃 → FAIL（父进程存活）', r.verdict === 'FAIL' && r.crashed === true, `${r.verdict}: ${r.reason}`);
}
{
  const r = trialInstall({ pluginDir: T('hangs'), timeoutMs: 3000 });
  check('T4', '挂起超时 → FAIL（父进程存活）', r.verdict === 'FAIL' && r.timeout === true, `${r.verdict}: ${r.reason}`);
}

rmSync(TMP, { recursive: true, force: true });
const metrics = {
  all: results.every((r) => r.pass),
  diff: results.filter((r) => r.id.startsWith('D') && r.pass).length,
  trial: results.filter((r) => r.id.startsWith('T') && r.pass).length,
  total: results.length,
};
report({ metrics, results });
