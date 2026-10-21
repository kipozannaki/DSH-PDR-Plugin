/**
 * 隔离试装（dry-install 门禁）—— 方案 §4.1③"失败即拦"
 *
 * 在一次性隔离环境（子进程 + 临时 DSH_HOME）里试启动插件，
 * 用真实 cordis + loader 验证"装上去会不会炸"，产出门禁判定：
 *   PASS  加载 + 启动干净
 *   WARN  启动成功但触发红线（功能可用，但需人工看红线）
 *   FAIL  加载失败 / 启动失败 / 进程崩溃 / 超时挂起
 *
 * 隔离价值：崩溃、死循环、process.exit 全部关在子进程里——
 * 真宿主不受影响，"失败即拦"的试错成本归零。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'trial-runner.mjs');

export function trialInstall({ pluginDir, timeoutMs = 10_000 } = {}) {
  const dir = path.resolve(pluginDir);
  const result = spawnSync(process.execPath, [RUNNER, dir], {
    timeout: timeoutMs,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
  });

  // ① 超时挂起（死循环 / 永不 resolve）
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return gate('FAIL', `试装超时（${timeoutMs}ms）：疑似挂起或死循环`, { timeout: true });
  }
  // ② 子进程崩溃 / 非零退出（含插件 process.exit）
  if (result.status !== 0) {
    return gate('FAIL', `试装进程异常退出（exit ${result.status}）：${(result.stderr || '').slice(0, 200).trim() || '插件可能调用了 process.exit'}`, { crashed: true, exitCode: result.status });
  }
  // ③ 无有效输出
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return gate('FAIL', '试装无有效输出（模块加载即崩）', { crashed: true });
  }

  // ④ 加载 / 启动失败
  if (!parsed.importOk) return gate('FAIL', `加载失败：${parsed.error || '模块无法 import'}`, parsed);
  if (!parsed.startOk) return gate('FAIL', `启动失败：${parsed.error || 'fiber 未启动（可能缺注入服务）'}`, parsed);
  // ⑤ 启动成功但触发红线
  if (parsed.redFlags?.length) {
    return gate('WARN', `启动成功，但触发红线：${[...new Set(parsed.redFlags)].join(' / ')}（需人工确认）`, parsed);
  }
  return gate('PASS', '隔离试装通过：加载 + 启动干净', parsed);
}

function gate(verdict, reason, extra = {}) {
  return { verdict, reason, isolated: true, ...extra };
}
