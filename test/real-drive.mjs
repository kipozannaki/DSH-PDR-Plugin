/**
 * 运行时行为回归 · 真实代码驱动：真实插件（dsh-rewind-plugin）的 SnapshotStore
 * 直接实例化驱动，验证：
 *  ① 真实 bundle 帧（具名导入 node:fs/promises）的 I/O 能被 hook 并归因到插件
 *  ② 栈归因（未包裹调用）与 ALS 归因（runAs 包裹）在真实代码上都成立
 *  ③ 归因隔离：实验脚本自身的 I/O 归 'host'，不串到插件头上
 */
import path from 'node:path';
import { report, skip } from './_report.mjs';
import { findInstalledPlugin, buildPluginOverlay } from './_deps.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);
const probe = req('../src/probe/probe-core.cjs');

const PLUGIN_NAME = process.env.PDR_REAL_PLUGIN || 'dsh-rewind-plugin';
// 开源前这里写死了作者本机的 tauri profile；别人机器上没有 → 必须明确跳过而不是红
const FOUND = findInstalledPlugin(PLUGIN_NAME);

const out = {};
if (!FOUND) {
  skip(
    `本机未安装真实插件 ${PLUGIN_NAME}（本用例用真实社区插件的代码驱动归因）`,
    `dsh plugin --profile <某个 profile> add ${PLUGIN_NAME}；或设 PDR_REAL_PLUGIN_DIR 指向插件目录`,
  );
} else {
  // 本用例**同时**验证栈归因与 ALS 归因，所以必须显式要 'both'：
  // 默认模式已是 'als'（无 ALS 上下文时直接归 host，不做栈兜底），
  // 用默认值跑会让 ① 的"未包裹调用"永远归 host，测不到栈归因这条路径。
  probe.install({ mode: process.env.PDR_PROBE_MODE || 'both' });

  // 真实插件依赖 DSH 运行时自带的 @deepseek-ai/*，profile 里没有 → 搭临时 overlay
  const overlayRoot = mkdtempSync(path.join(tmpdir(), 'fw-overlay-'));
  const PLUGIN_DIR = buildPluginOverlay(FOUND, overlayRoot) ?? FOUND;
  // 目录映射必须覆盖**实际被 import 的那一份**：overlay 里的是副本，
  // 栈帧路径指向 overlay 而非原目录，只注册原目录会让栈归因落到 'host'。
  probe.registerPlugin(PLUGIN_NAME, PLUGIN_DIR);
  if (PLUGIN_DIR !== FOUND) probe.registerPlugin(PLUGIN_NAME, FOUND);

  try {
    const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib/index.js')).href);
    const SnapshotStore = mod.SnapshotStore;
    out.exportedApi = Object.keys(mod);
    if (typeof SnapshotStore !== 'function') throw new Error('SnapshotStore 未导出');

    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fw-realdrive-'));
    const store = new SnapshotStore(tmpRoot, { dedup: true });

    const summarize = (label) => {
      const events = probe.getEvents({ limit: 200 });
      const byActor = {};
      for (const e of events) byActor[e.actor] = (byActor[e.actor] || 0) + 1;
      return {
        label,
        byActor,
        apis: [...new Set(events.map((e) => e.api))],
        samples: events.slice(0, 4).map((e) => ({ actor: e.actor, api: e.api, target: String(e.target).slice(0, 70) })),
      };
    };

    // ① 栈归因：直接调用（不包 runAs），期待真实 bundle 帧归因到插件
    probe.reset();
    await store.stageCapture('regress-1', 'probe-key');
    out.stackMode = summarize('未包裹调用');

    // ② ALS 归因：runAs 包裹（模拟宿主插件边界），异步续体也归插件
    probe.reset();
    await probe.runAs(PLUGIN_NAME, async () => {
      await store.stageCapture('regress-1', 'probe-key-2');
      await store.sessionStats('regress-1').catch(() => {});
      await store.trackedPaths('regress-1').catch(() => {});
      await store.listJournals('regress-1').catch(() => {});
    });
    out.alsMode = summarize('runAs 包裹');

    // ③ 归因隔离负对照：实验脚本自己的 I/O 应归 host
    probe.reset();
    req('node:fs').readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8');
    out.hostControl = summarize('宿主自身调用');

    out.pass = {
      stackAttributesToPlugin: (out.stackMode.byActor[PLUGIN_NAME] || 0) > 0,
      alsAttributesToPlugin: (out.alsMode.byActor[PLUGIN_NAME] || 0) > 0 && out.alsMode.byActor.host == null,
      hostIsolated: out.hostControl.byActor.host === 1 && out.hostControl.byActor[PLUGIN_NAME] == null,
    };
    out.ok = Object.values(out.pass).every(Boolean);

    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(overlayRoot, { recursive: true, force: true });
  } catch (error) {
    out.ok = false;
    out.error = String(error?.stack ?? error).split('\n').slice(0, 8).join('\n');
    try { rmSync(overlayRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  report(out);
}
