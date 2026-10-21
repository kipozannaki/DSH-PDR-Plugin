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
  console.error(`dsh-pdr: 未知子命令 ${cmd}（可用：audit / aggregate）`);
  return 1;
}

const SUBCOMMANDS = new Set(['audit', 'aggregate']);
if (SUBCOMMANDS.has(process.argv[2])) {
  runSubcommand(process.argv[2]).then((code) => process.exit(code));
} else {

const PRELOAD = resolvePreload();

// 自检模式：验证预载可用（dsh-pdr --pdr-check）
if (process.argv.includes('--pdr-check')) {
  const ok = fs.existsSync(PRELOAD);
  console.log(JSON.stringify({
    preload: PRELOAD,
    exists: ok,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    hint: ok ? '预载就绪；用 dsh-pdr <args> 启动即生效' : 'preload.cjs 缺失',
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

const child = spawn(dsh, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32', // Windows 用 cmd 解析 dsh.cmd；Unix 直接找 dsh
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

child.on('error', (e) => {
  console.error(`dsh-pdr: 无法启动 ${dsh}: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

} // end of launcher branch (SUBCOMMANDS 未命中)
