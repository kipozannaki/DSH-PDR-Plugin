/**
 * 体检卡 v0（方案 §4.1①）：静态提取能力面 + 红线组合 + PASS/WARN/BLOCK
 *
 * 诚实声明：这是启发式静态信号，**不是安全证明**。
 * - 输入有限：只扫 manifest / bundle patch / 包内代码文本
 * - 用途是"体检卡"的初筛与能力可视化，运行时真相以行为防火墙时间线为准
 * - 能力词汇沿用生态共识（方案 §4.1）：
 *   shell / fs-read / fs-write / network / env / credentials / dynamic-code
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const CAPABILITY_SIGNALS = {
  network: {
    deps: ['axios', 'undici', 'node-fetch', 'got', 'ws', 'socket.io', 'superagent', 'form-data', 'nodemailer', 'imapflow'],
    /**
     * 真机 M1 实测误报：浏览器半边的 `fetch("/api/xxx")` 是**同源相对路径**请求，
     * 打的是宿主自己的 HTTP 路由，不是对外网络能力。原正则只匹配 `fetch(`，
     * 把大量纯 UI 插件误标 network，进而误报 credentials+network（实测误报 7/20）。
     * 修法：fetch 必须带**绝对 URL 或变量/模板**才算网络能力，纯字符串相对路径不算。
     */
    code: /\bfetch\s*\(\s*(?!['"`]\s*\/)|https?\.(request|get)\b|\bnet\.connect\b|\bWebSocket\b|\baxios\b|\bundici\b/,
  },
  'fs-read': { code: /readFile|createReadStream|\breaddir\b|\bexistsSync\b/ },
  'fs-write': { code: /writeFile|createWriteStream|appendFile|\bmkdir\b|\brmSync\b|\bunlink\b/ },
  shell: {
    deps: ['execa', 'cross-spawn', 'shelljs', 'tinyexec', 'node-pty'],
    code: /child_process|execSync|spawnSync|\bspawn\s*\(|\bexecFile\b/,
  },
  /**
   * 凭据能力：真实生态插件几乎不直接读 .credentials.yaml 字面量，
   * 而是走 DSH 凭据服务（ctx.get('credentials') / api.credentials.*）。
   * 真机 M1 实测：只认字面量路径会让 15/27 个已知"凭据+联网"插件漏报（召回仅 45%）。
   *
   * 口径（与生态 capabilities.json 对齐，避免误报）：
   *   收 —— 文件字面量 + DSH 凭据服务调用
   *   不收 —— 泛化的 process.env 取用（生态把它单列为独立的 env 能力，
   *          若也当凭据，会把大量只读环境变量的插件误标成"凭据+联网"，
   *          实测误报率从 5% 涨到 35%）
   */
  credentials: {
    code: /\.credentials\.yaml|credentials[-_]?vault|\bctx\.get\s*\(\s*['"`]credentials['"`]\s*\)|\bctx\.credentials\b|\bapi\.credentials\.(describe|set|get|delete|list)\b|\bcredentials\.(describe|set|get)\s*\(|\bapi[_-]?key\s*[:=]|\baccess[_-]?token\s*[:=]/i,
  },
  // 强动态执行信号（真实回归教训：import( / require(变量) 在打包产物里是
  // 注释、类型标注、同名方法的噪声场，只有这些才值得叫 dynamic-code）
  'dynamic-code': { code: /\bnew Function\s*\(|\beval\s*\(|\bvm\.|\bFunction\s*\(\s*['"`]/ },
  env: { code: /process\.env/ },
};

/**
 * 明文 http:// 端点提取（两轮真实回归教训的产物）：
 *  裸 regex 会命中命名空间/规范文档/许可证注释/占位符/模板插值（实测 96 处全是噪声），
 *  因此候选端点还必须满足"语境"条件之一：
 *    a) 紧邻网络调用（fetch/request/axios/WebSocket/…）
 *    b) 赋值给 URL 语义的标识符（xxx_URL / endpoint / webhook / …）
 *  再排除：本机与保留域、命名空间域、example.* 文档域、注释行、模板插值、非端点后缀
 */
const HTTP_URL_RE = /http:\/\/([^\s'"`)]+)/g;
const NON_ENDPOINT_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;
const NON_ENDPOINT_TLD = /\.(internal|local|localhost|invalid|test)$/i;
const NON_ENDPOINT_DOMAIN = /(w3\.org|w3\.net|json-schema\.org|schema\.org|xml\.org|xmlns|iana\.org|microsoft\.com|ecma-international\.org|opensource\.org|wikipedia\.org|example\.(com|org|net|dev|test)|\.example)$/i;
const ENDPOINT_NAME_RE = /(?:url|uri|endpoint|base_?url|host|server|addr(?:ess)?|webhook|c2)[\w$]*\s*[:=]\s*['"`]http:\/\/|['"`]http:\/\/[^'"`]*['"`]\s*,\s*\{[^}]*(?:url|endpoint|host)/i;
const ENDPOINT_CALL_RE = /(fetch\s*\(|https?\.(request|get|post)|\baxios\b|WebSocket|net\.connect|\.post\s*\(|\.get\s*\(\s*['"`]|\.open\s*\()/;

function findCleartextEndpoints(code) {
  const found = new Set();
  for (const m of code.matchAll(HTTP_URL_RE)) {
    const raw = m[1];
    const idx = m.index ?? 0;
    if (/[#]$/.test(raw) || /\.(xsd|wsdl|dtd|xml|svg|png|jpg)$/.test(raw)) continue;
    const host = (raw.split('/')[0].split(':')[0] || '').toLowerCase();
    if (!host || host.includes('${')) continue; // 模板插值不是字面端点
    if (NON_ENDPOINT_HOST.test(host) || NON_ENDPOINT_TLD.test(host) || NON_ENDPOINT_DOMAIN.test(host)) continue;
    // 注释行排除（* / // / /* 开头的行）
    const lineStart = code.lastIndexOf('\n', idx) + 1;
    const linePrefix = code.slice(lineStart, idx).trim();
    if (/^(\/\/|\/\*|\*|<!--)/.test(linePrefix)) continue;
    // 语境条件：调用上下文 或 URL 语义赋值
    const window = code.slice(Math.max(0, idx - 140), idx + raw.length + 60);
    if (!ENDPOINT_CALL_RE.test(window) && !ENDPOINT_NAME_RE.test(code.slice(Math.max(0, idx - 120), idx + raw.length + 20))) continue;
    found.add('http://' + raw.slice(0, 80));
  }
  return [...found];
}

/**
 * 硬编码密钥字面量（泄露路径证据）。
 * 三轮回归教训：① 裸前缀 regex 命中标识符（`ta[sk]sView…` 711 处噪声）
 * ② "密钥名 + 长字面量"会抓到 API 路径常量（TOKEN_PATH = "/trae/api/…"）
 * ③ 多文件拼接的 \s* 会跨文件边界假配 —— 因此逐文件扫描 + 值形状过滤
 */
const SECRET_IN_STRING_RE = /['"`](?:(?:sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|AIza)[A-Za-z0-9_-]{20,})['"`]/;
const SECRET_ASSIGN_RE = /(?:api[_-]?key|secret|token|passwd|password|credential)[\w$]*\s*[:=]\s*['"`]([A-Za-z0-9_/+.=-]{20,})['"`]/i;

function findHardcodedSecret(text) {
  for (const m of text.matchAll(new RegExp(SECRET_ASSIGN_RE, 'gi'))) {
    const v = m[1];
    // 值形状过滤：API 路径 / URL 常量不是密钥（'/trae/api/v3/…'、'https://…'）
    if (v.startsWith('/') || v.includes('://') || /^[\w.-]+(\/[\w.-]+)+$/.test(v)) continue;
    return v.slice(0, 40);
  }
  if (SECRET_IN_STRING_RE.test(text)) return 'token-prefix-literal';
  return null;
}

const DISCLAIMER = '启发式静态信号，非安全证明；运行时行为以防火墙时间线为准';

function listScanFiles(root, limit = 60) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 4) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(js|cjs|mjs)$/.test(e.name) && !e.name.endsWith('.map')) {
        try {
          const st = statSync(full);
          if (st.size <= 2 * 1024 * 1024) out.push(full);
        } catch { /* 跳过不可读 */ }
      }
    }
  };
  /**
   * 只扫真正执行的运行时代码：dist → lib → src（有产物目录时不重复扫源码，避免构建脚本误报）。
   *
   * 真机 M1 实测缺陷：原实现在第一个存在的目录就 `return`，
   * 但大量真实插件把代码直接放在**包根**（index.js/client.js/…），只有 docs/lib 之类子目录。
   * 结果只扫到 1 个文件 → 能力面几乎全空 → "凭据+联网"整类漏报（20 个样本漏 7 个）。
   * 修法：产物目录若没扫到足量文件，继续回落扫包根；两者取并集上限。
   */
  const before = out.length;
  for (const sub of ['dist', 'lib', 'src']) {
    const dir = path.join(root, sub);
    if (!existsSync(dir)) continue;
    walk(dir, 0);
    if (out.length > before) break; // 已扫到产物/源码目录，不再重复扫包根
  }
  if (out.length === 0) walk(root, 0); // 代码在包根（真实插件很常见）
  else {
    // 产物目录文件很少时（典型：只有 dist/README 之类），补扫包根，
    // 否则会漏掉与产物同层的运行时文件
    if (out.length < 3) walk(root, 0);
  }
  return out;
}

/** 从 bundle patch 里提取它往宿主插入的条目（id/name 行，正则轻提，不引 YAML 依赖） */
function listPatchEntries(root) {
  const patchPath = path.join(root, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return [];
  try {
    const yml = readFileSync(patchPath, 'utf8');
    const ids = [...yml.matchAll(/^\s*(?:-\s*)?id:\s*["']?([\w.@/-]+)/gm)].map((m) => m[1]);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function healthCard(packageDir) {
  const dir = path.resolve(packageDir);
  const manifestPath = path.join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    return { error: 'not-a-package', dir, disclaimer: DISCLAIMER };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const depNames = Object.keys({ ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) });

  const files = listScanFiles(dir);
  let truncated = files.length >= 60;
  const perFile = []; // 逐文件文本：红线证据逐文件提取，杜绝跨文件拼接假配
  let code = '';
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    perFile.push(text);
    code += text + '\n';
    if (code.length > 4 * 1024 * 1024) { truncated = true; break; }
  }

  // 能力面提取（依赖证据 + 代码证据）
  const capabilities = [];
  for (const [id, sig] of Object.entries(CAPABILITY_SIGNALS)) {
    const evidence = [];
    for (const d of sig.deps || []) if (depNames.includes(d)) evidence.push(`dep:${d}`);
    if (sig.code && sig.code.test(code)) evidence.push('code');
    if (evidence.length) capabilities.push({ id, evidence });
  }
  const has = (id) => capabilities.some((c) => c.id === id);

  // 红线组合 —— 真实回归教训：能力共现 ≠ 恶意（IM/QQ 桥"凭据+网络"是功能必需）。
  // 分两级：
  //   capability = 能力红线：可能功能必需，需确认来源与运行时行为（→ WARN）
  //   exfil-path = 泄露路径证据：凭据 + 真实远程明文端点 / 硬编码密钥（→ BLOCK）
  const redLines = [];
  const cleartext = [...new Set(perFile.flatMap((t) => findCleartextEndpoints(t)))];
  if (has('network') && has('credentials')) {
    redLines.push({ rule: 'credentials+network', severity: 'capability', evidence: '凭据访问 + 网络能力（可能功能必需，如 IM/QQ 桥）' });
  }
  if (has('shell') && has('credentials')) {
    redLines.push({ rule: 'credentials+subprocess', severity: 'capability', evidence: '凭据访问 + 子进程执行' });
  }
  if (has('dynamic-code') && has('network')) {
    redLines.push({ rule: 'dynamic-code+network', severity: 'capability', evidence: '动态执行 + 网络能力' });
  }
  if (cleartext.length) {
    redLines.push({
      rule: 'cleartext-http',
      severity: has('credentials') ? 'exfil-path' : 'capability',
      evidence: `硬编码明文端点：${cleartext.slice(0, 3).join(' , ')}`,
    });
  }
  const secret = perFile.map((t) => findHardcodedSecret(t)).find(Boolean);
  if (secret) {
    redLines.push({ rule: 'hardcoded-secret', severity: 'exfil-path', evidence: `疑似硬编码密钥字面量：${secret}` });
  }

  // 判定策略（方案 §6.1"默认不替用户做决定"）：
  // BLOCK 只留给泄露路径证据；能力红线是"请人工确认"，不是有罪判决
  const verdict = redLines.some((r) => r.severity === 'exfil-path')
    ? 'BLOCK'
    : redLines.length ? 'WARN' : 'PASS';

  return {
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 160) : '',
    capabilities,
    redLines,
    verdict,
    patchEntries: listPatchEntries(dir),
    scanned: { files: files.length, truncated },
    disclaimer: DISCLAIMER,
  };
}
