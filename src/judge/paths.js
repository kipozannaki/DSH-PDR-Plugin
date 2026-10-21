/**
 * 路径分类器 —— 目标越界判定的基础
 *
 * 回答"这个文件该不该碰"：不看行为多危险，看**目标是谁的**。
 * 分类（优先级从上到下）：
 *   own          插件自己的目录（它的代码/资源/缓存）——天然允许
 *   sensitive    全局凭据与密钥类：~/.dsh/.credentials.yaml、~/.ssh、~/.aws、
 *                浏览器密码库等——默认谁都不许碰
 *   other-plugin 其他插件的目录——插件之间互不许进
 *   temp         系统临时目录——天然允许
 *   dsh-shared   ~/.dsh 下的共享区（sessions/skills/市场缓存等）——允许读，写看授权
 *   system       系统/宿主程序目录——只读常识区
 *   unknown      其他（用户文档、任意路径）——默认允许但计数（供基线用）
 */
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_PATTERNS = [
  /[\\/]\.credentials\.yaml$/i,
  /[\\/]\.dsh[\\/][^\\/]*credentials/i,
  /[\\/]\.ssh[\\/]/i,
  /id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /[\\/]\.git-credentials$/i,
  /[\\/](google|chrome|edge|brave)[\\/].*user data[\\/].*(login data|cookies)/i,
  /[\\/]\.config[\\/]gh[\\/]/i,
  /[\\/]_?netrc$/i,
  /[\\/]\.npmrc$/i, // 可能含 _auth token
];

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
const stripUrl = (p) => {
  const s = String(p ?? '');
  return s.startsWith('file://') ? s.replace(/^file:\/\//, '') : s;
};

export function classifyPath(target, { ownDirs = [], pluginDirs = new Map() } = {}) {
  const p = norm(stripUrl(target));
  if (!p) return { class: 'unknown', detail: '' };
  const own = ownDirs.map((d) => norm(d));
  const tmp = norm(os.tmpdir());

  if (own.some((d) => d && p.startsWith(d + '/'))) return { class: 'own', detail: '' };

  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(p)) return { class: 'sensitive', detail: re.source };
  }

  for (const [dir, name] of pluginDirs) {
    const d = norm(dir);
    if (d && p.startsWith(d + '/')) {
      return own.some((o) => d === o) ? { class: 'own', detail: '' } : { class: 'other-plugin', detail: name };
    }
  }

  if (tmp && (p.startsWith(tmp + '/') || p.includes('/temp/'))) return { class: 'temp', detail: '' };

  const home = norm(os.homedir());
  if (p.startsWith(home + '/.dsh/')) return { class: 'dsh-shared', detail: '' };
  if (p.startsWith(home + '/.dsh-market/') || p.includes('/node_modules/')) return { class: 'system', detail: '' };

  return { class: 'unknown', detail: '' };
}

/** 凭据类目标判定（与红线规则 credentials-access 同口径）——凭据外发组合的触发信号 */
export const CREDENTIAL_TARGET_RE = /\.credentials\.yaml$|credentials\.yaml$|[\\/]\.dsh[\\/].*credential/i;
export function isCredentialTarget(target) {
  return CREDENTIAL_TARGET_RE.test(String(target ?? ''));
}

/** 从网络目标提取 host（用于目的地越界判定） */
export function hostOf(target) {
  const s = String(target ?? '');
  if (!/^[a-z]+:\/\//i.test(s)) return '';
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** host 匹配：精确或 *.suffix 通配 */
export function hostMatches(host, patterns) {
  if (!host) return false;
  return patterns.some((pat) => {
    const p = String(pat).toLowerCase().replace(/^\*\./, '');
    return host === p || host.endsWith('.' + p);
  });
}
