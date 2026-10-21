/**
 * 确定性验证：binding 归因 + 现场包解析 + fd→路径（真机暴露的三个问题的修复）
 *
 * 模拟真机场景：插件用 ORIGINAL fs.writeFileSync（绕过 property 层，走 binding），
 * 探针**未预注册**该插件（真机里注册晚于插件 I/O），验证现场 package.json 解析归因。
 *
 * 用法：node test/bind-attrib-diag.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { report } from './_report.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const probe = require('../src/probe/probe-core.cjs');

const TMP = mkdtempSync(path.join(tmpdir(), 'fw-bind-'));
const PLG = path.join(TMP, 'test-plg');
mkdirSync(PLG);
writeFileSync(path.join(PLG, 'package.json'), JSON.stringify({ name: 'test-plg', version: '1.0.0', type: 'module', main: 'w.mjs' }));
writeFileSync(path.join(PLG, 'w.mjs'), `
import fs from 'node:fs';
export function doWrite(p) {
  const orig = fs.writeFileSync.__orig || fs.writeFileSync; // 绕过 property 层 → 走 binding
  orig(p, 'hello');
}
export function doRead(p) {
  const orig = fs.readFileSync.__orig || fs.readFileSync;
  return orig(p, 'utf8');
}
`);

/**
 * 本测试验证的是**栈归因**（插件未 runAs 包裹时，靠调用栈现场解析 package.json）。
 * 探针默认模式已改为 'als'（性能优先，见 research/M0开销终审-v0.md），
 * 该模式下无 ALS 上下文会直接归 'host'，所以这里必须显式要求 stack ——
 * 否则测的不是"归因能力"，而是"默认模式选了什么"。
 */
probe.install({ mode: 'stack' }); // 不预注册任何插件——测现场解析
const mod = await import(pathToFileURL(path.join(PLG, 'w.mjs')).href);
const outFile = path.join(TMP, 'out.txt');

probe.reset();
mod.doWrite(outFile);           // 写：走 binding
mod.doRead(outFile);            // 读：走 binding（orig）
const evts = probe.getEvents();

const results = [];
const check = (id, label, pass, detail) => results.push({ id, label, pass: !!pass, detail });

const writeEvt = evts.find((e) => /write/i.test(e.api));
const readEvt = evts.find((e) => /readFile/i.test(e.api) && String(e.target).includes('out.txt'));
check('A', '写被 binding 捕获', !!writeEvt, JSON.stringify(writeEvt && { api: writeEvt.api, target: writeEvt.target }));
check('B', '写归因到 test-plg（现场解析，未预注册）', writeEvt?.actor === 'test-plg', writeEvt?.actor);
check('C', '写事件有真路径（fd→path 反查）', writeEvt?.target === outFile, writeEvt?.target);
check('D', '读归因到 test-plg', readEvt?.actor === 'test-plg', readEvt?.actor);

rmSync(TMP, { recursive: true, force: true });
report({ all: results.every((r) => r.pass), results });
