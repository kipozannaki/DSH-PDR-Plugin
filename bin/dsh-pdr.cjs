#!/usr/bin/env node
/**
 * DSH-PDR 启动器 —— 把预载打包进产品
 *
 * 用 `dsh-pdr` 替代 `dsh`，即可让 DSH-PDR 探针在宿主启动**最早期**安装
 * （早于一切 ESM facade 创建与插件 I/O，绕开真机时序问题），其余用法与 `dsh` 完全一致：
 *
 *   dsh-pdr web                          # = dsh web（+ 预载）
 *   dsh-pdr headless "run tests"         # = dsh headless …（+ 预载）
 *   dsh-pdr plugin --profile x add <pkg> # = dsh plugin …（+ 预载）
 *
 * 原理：设 NODE_OPTIONS=--require <本包>/src/probe/preload.cjs 后转发给 dsh，
 * dsh 的 node 进程继承该环境变量 → 预载模块先于一切执行。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HERE = __dirname;
const args = process.argv.slice(2).filter((a) => a !== '--pdr-check');

/**
 * 预载要指向**目标 profile 里安装的那一份**，与 bundle earlyInstall 加载的模块同一身份。
 * 若指向本包自带副本（全局安装/源码目录），进程里会出现两份探针：各自 install 会把 fs
 * 包两层，__orig 指向包装器 → 记账自我递归（实测 27 万条/37MB）。探针核心另有全局单例
 * 兜底，但同一份文件才能让 SELF_ROOT/自观测排除也正确。
 */
function resolvePreload() {
  const local = path.resolve(HERE, '..', 'src', 'probe', 'preload.cjs');
  const i = args.indexOf('--profile');
  let profile = i >= 0 ? args[i + 1] : null;
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  // 位置式写法 dsh-pdr web：首个非选项参数若对应已有 profile，也按该 profile 解析
  if (!profile && args[0] && !args[0].startsWith('-')) {
    if (fs.existsSync(path.join(home, 'profiles', args[0]))) profile = args[0];
  }
  if (profile) {
    const installed = path.join(home, 'profiles', profile, 'node_modules', 'dsh-pdr-plugin', 'src', 'probe', 'preload.cjs');
    if (fs.existsSync(installed)) return installed;
  }
  return local;
}

/**
 * 合规导出/汇总的子命令（M3）。
 *
 * 为什么要在启动器里做而不是宿主插件里：审计导出是**离线**动作——
 * 安全团队要的是"关闭会话之后仍能导出一份留档"，不该要求先启动一个宿主。
 * 这些子命令直接读 JSONL，不启动 dsh，也不装任何 hook。
 *
 *   dsh-pdr audit [--format sarif|csv|json|md] [--out FILE] [--data-dir DIR]
 *   dsh-pdr aggregate --source LABEL=DIR [--source ...] [--format json|md] [--out FILE]
 *   dsh-pdr doctor [--json] [--data-dir DIR]   # 上次会话的监控健康状态（v0.3）
 */
async function runSubcommand(cmd) {
  const argv = process.argv.slice(3);
  const getOpt = (name, def = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const getAll = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
    return out;
  };
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const dataDir = getOpt('--data-dir', path.join(home, 'firewall'));
  const outFile = getOpt('--out');
  const format = getOpt('--format', cmd === 'audit' ? 'md' : 'md');

  const emit = (text) => {
    if (outFile) { fs.writeFileSync(outFile, text); console.error(`written: ${outFile}`); }
    else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  };

  try {
    /**
     * doctor：回答"上次会话到底监控到什么程度"。
     * 数据来自插件在 apply 时落的 <dataDir>/runtime.json（脱敏后），
     * 没有活会话也能查——这正是长期留档的价值。
     */
    if (cmd === 'doctor') {
      const file = path.join(dataDir, 'runtime.json');
      let snapshot = null;
      try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { snapshot = null; }
      if (!snapshot) {
        const msg = `未找到运行时快照：${file}\n`
          + '  说明：本机还没有用 dsh-pdr 启动过宿主，或插件的 apply 未执行。\n'
          + '  先运行  dsh-pdr --profile <profile> web  让探针在真实会话里跑起来。';
        if (argv.includes('--json')) emit(JSON.stringify({ ok: false, error: 'no-snapshot', path: file }, null, 2));
        else emit(msg);
        return 1;
      }
      const h = snapshot.health || { state: 'UNKNOWN', reasons: [] };
      const rt = snapshot.runtime || {};
      const boot = snapshot.bootstrap || {};
      const probe = snapshot.probe || {};
      const at = snapshot.attribution || {};
      const cov = snapshot.coverage || {};
      if (argv.includes('--json')) {
        emit(JSON.stringify(snapshot, null, 2));
        return 0;
      }
      const lines = [
        `DSH-PDR 运行时健康  ${h.state}`,
        `  快照时间   ${new Date(snapshot.generatedAt).toLocaleString()}`,
        `  启动入口   ${boot.label || boot.adapter}（supported=${boot.supported}）`,
        `  预载执行   ${boot.preloadRan ? '是' : '否'}`,
        `  宿主版本   dsh ${rt.dshVersion || '?'} / node ${rt.node || '?'} / ${rt.platform || '?'}`,
        `  探针       installed=${probe.installed} mode=${probe.mode} hooks=${probe.hooksWrapped}`,
        `  归因       具名插件 ${at.pluginsAttributed || 0} · host ${at.host || 0} · unknown ${at.unknown || 0}`,
        `  覆盖缺口   ${(cov.gaps || []).length ? cov.gaps.join(', ') : '无'}`,
        `  事件       ${probe.totalEvents || 0} 条（丢弃 ${probe.dropped || 0}，错误 ${probe.errors || 0}）`,
      ];
      if ((h.reasons || []).length) {
        lines.push('  缺口原因：');
        for (const r of h.reasons) lines.push(`    - [${r.code}] ${r.zh || r.detail}`);
      }
      if ((h.notes || []).length) {
        lines.push('  提示（不降级）：');
        for (const r of h.notes) lines.push(`    - [${r.code}] ${r.zh || r.detail}`);
      }
      const sites = probe.errorSites && typeof probe.errorSites === 'object' ? Object.keys(probe.errorSites) : [];
      if (sites.length) lines.push(`  错误站点   ${sites.map((k) => `${k}×${probe.errorSites[k]}`).join(', ')}`);
      if (boot.evidence) lines.push(`  判定依据   ${boot.evidence}`);
      if (boot.limitation) lines.push(`  入口限制：${boot.limitation}`);
      emit(lines.join('\n'));
      return h.state === 'OFFLINE' ? 1 : 0;
    }

    if (cmd === 'audit') {
      const { aggregateSources, profileByActor, redLineSummary, aggregateMarkdown } = await import('../src/report/aggregate.js');
      const { toSarif, toCsv } = await import('../src/report/compliance.js');
      const { generateAuditReport, auditReportMarkdown } = await import('../src/report/audit.js');

      const agg = aggregateSources([{ label: path.basename(dataDir) || 'data', dir: dataDir }]);
      // 离线场景没有活的探针：用事件流重建一个 api 供审计报告复用。
      // 注意红线在事件上是数组（redLines，调用内去重后的形状），
      // 审计报告期望的是展开后的 {rule,...} 记录——不展开就会渲染成 undefined。
      const events = agg.events;
      const flattenRedFlags = () => {
        const out = [];
        for (const e of events) {
          const rules = Array.isArray(e.redLines) ? e.redLines : (e.redLine ? [e.redLine] : []);
          for (const rule of rules) {
            out.push({ rule, t: e.t, actor: e.actor, api: e.api, target: e.target });
          }
        }
        return out;
      };
      const viewApi = {
        getVerdicts: () => [],
        listContracts: () => ({ overrides: [], drafts: [] }),
        getSummary: () => ({ actors: profileByActor(events), stats: {} }),
        getRedFlags: flattenRedFlags,
        getStats: () => ({
          mode: 'offline', totalEvents: events.length, stored: events.length,
          dropped: 0, blocked: events.filter((e) => (e.flags ?? []).includes('blocked')).length,
          errors: 0, installed: false,
        }),
        getEvents: () => events.slice(-1000),
        getAlertStats: () => null,
      };
      const report = generateAuditReport(viewApi);
      if (format === 'sarif') emit(JSON.stringify(toSarif(report), null, 2));
      else if (format === 'csv') emit(toCsv(report));
      else if (format === 'json') emit(JSON.stringify(report, null, 2));
      else emit(auditReportMarkdown(report));
      return 0;
    }

    if (cmd === 'aggregate') {
      const { aggregateSources, profileByActor, redLineSummary, aggregateMarkdown } = await import('../src/report/aggregate.js');
      let sources = getAll('--source');
      if (!sources.length) sources = [`${path.basename(dataDir) || 'data'}=${dataDir}`];
      const parsed = sources.map((s) => {
        const eq = s.indexOf('=');
        return eq > 0 ? { label: s.slice(0, eq), dir: s.slice(eq + 1) } : { label: path.basename(s), dir: s };
      });
      const agg = aggregateSources(parsed);
      if (format === 'json') {
        emit(JSON.stringify({ ...agg, actors: profileByActor(agg.events), redLines: redLineSummary(agg.events) }, null, 2));
      } else emit(aggregateMarkdown(agg));
      return 0;
    }
  } catch (e) {
    console.error(`dsh-pdr ${cmd}: ${e && e.message}`);
    return 1;
  }
  console.error(`dsh-pdr: 未知子命令 ${cmd}（可用：audit / aggregate / doctor）`);
  return 1;
}

const SUBCOMMANDS = new Set(['audit', 'aggregate', 'doctor']);
if (SUBCOMMANDS.has(process.argv[2])) {
  runSubcommand(process.argv[2]).then((code) => process.exit(code));
} else {

const PRELOAD = resolvePreload();

/**
 * 自检模式（v0.3 §4.2：CLI 自检）：不只报"预载文件在不在"，
 * 还给出启动入口能力矩阵——用户能立刻看到 Desktop 这类入口为什么不支持。
 */
if (process.argv.includes('--pdr-check')) {
  const ok = fs.existsSync(PRELOAD);
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')).version; } catch { /* 版本读不到不影响自检 */ }
  const i = args.indexOf('--profile');
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const profile = i >= 0 ? args[i + 1] : (args[0] && !args[0].startsWith('-') && fs.existsSync(path.join(home, 'profiles', args[0])) ? args[0] : null);
  const desktop = /dsh[-_ ]?tauri|deepseek[-_ ]?harness[-_ ]?desktop/i.test(String(process.execPath || '') + ' ' + String(process.argv[1] || ''));
  console.log(JSON.stringify({
    schema: 'dsh-pdr/check/v1',
    pluginVersion: version,
    preload: PRELOAD,
    exists: ok,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    profile,
    dshHome: (process.env.DSH_HOME || home).replace(process.env.USERPROFILE || process.env.HOME || '\u0000', '<home>'),
    detectedAdapter: process.env.PDR_BOOTSTRAP ? 'launcher' : (desktop ? 'desktop' : (ok ? 'launcher(ready)' : 'none')),
    adapters: [
      { id: 'launcher', label: 'dsh-pdr 启动器', supported: true, injects: 'NODE_OPTIONS=--require preload.cjs' },
      { id: 'preload', label: '外部 NODE_OPTIONS 预载', supported: true, injects: 'NODE_OPTIONS=--require preload.cjs' },
      { id: 'desktop', label: 'DSH Desktop 内置启动器', supported: false, limitation: '桌面应用自行启动宿主，无法注入 NODE_OPTIONS' },
      { id: 'bundle', label: 'bundle earlyInstall（晚装）', supported: 'degraded', limitation: '缺预载窗口，早于插件入口的 I/O 不可见' },
    ],
    hint: ok
      ? '预载就绪。启动后用面板「行为监控」顶部横幅、或 `dsh-pdr doctor` 查看本次会话是否真的 FULL'
      : 'preload.cjs 缺失：插件未完整安装',
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (!fs.existsSync(PRELOAD)) {
  console.error(`dsh-pdr: 预载模块缺失 ${PRELOAD}`);
  process.exit(1);
}

// 设 NODE_OPTIONS=--require preload（追加到已有），转发全部参数给 dsh
// 用正斜杠：NODE_OPTIONS 解析会吃掉反斜杠
const preloadPosix = PRELOAD.replace(/\\/g, '/');
const nodeOptions = [process.env.NODE_OPTIONS, `--require "${preloadPosix}"`].filter(Boolean).join(' ');
const dsh = process.env.DSH_PDR_DSH || 'dsh';

/**
 * v0.3 Bootstrap 标记：让宿主进程里的 Runtime Detector 能确证
 * "是 dsh-pdr 启动器注入的"，而不是靠猜。PDR_PROFILE 供面板展示（脱敏）。
 */
const profileArg = (() => {
  const i = args.indexOf('--profile');
  if (i >= 0) return args[i + 1] || null;
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  if (args[0] && !args[0].startsWith('-') && fs.existsSync(path.join(home, 'profiles', args[0]))) return args[0];
  return null;
})();

const child = spawn(dsh, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32', // Windows 用 cmd 解析 dsh.cmd；Unix 直接找 dsh
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    PDR_BOOTSTRAP: 'launcher',
    PDR_PRELOAD_REQUESTED: '1',
    ...(profileArg ? { PDR_PROFILE: profileArg } : {}),
  },
});

child.on('error', (e) => {
  console.error(`dsh-pdr: 无法启动 ${dsh}: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

} // end of launcher branch (SUBCOMMANDS 未命中)
