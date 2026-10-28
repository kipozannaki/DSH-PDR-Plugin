/**
 * 插件入口配置 schema（schemastery）。
 *
 * 为什么必须有：cordis 对带 `config:` 的 loader entry 做 schema 校验；
 * 插件不导出 Config 时，patch 里任何 config 键都会让 entry 挂载失败
 * （真机实证：insert config 里的 mode/earlyInstall 让 entry 静默不激活，
 * boot manifest 里没有它、client 面板无从谈起）。
 *
 * 这里声明面板与探针真正消费的键；earlyInstall 是 !!js 表达式求值后的布尔，
 * 走 loose 放行，避免严格 schema 拒掉宿主注入的启动信号。
 */
import { createRequire } from 'node:module'

// schemastery 由宿主运行时提供（不打包进插件）；解析失败时退回「放行任意键」的
// 朴素实现，保证 entry 挂载绝不因 schema 库缺位而失败。
let z = null
try {
  z = createRequire(import.meta.url)('@deepseek-ai/schemastery')
} catch { z = null }
if (!z) {
  const chain = () => { const f = (v) => v ?? {}; const p = new Proxy(f, { get: (_t, k) => (k === 'loose' || k === 'default' || k === 'min' || k === 'step' ? () => p : f[k]) }); return p }
  z = { object: () => chain(), number: () => chain(), string: () => chain(), boolean: () => chain(), union: () => chain() }
}

export const Config = z.object({
  // 归因模式：als（默认，便宜）/ stack（诊断）/ both
  probeMode: z.union(['als', 'stack', 'both']).default('als').loose(),
  // 面板数据路由的取样上限（一次 overview 聚合扫描的事件数上限）
  scanLimit: z.number().min(100).step(100).default(2000).loose(),
  // 拦截策略（M2）：alarm 只告警（默认）；block 执行前拦截
  policyMode: z.union(['alarm', 'block']).default('alarm').loose(),
  // earlyInstall !!js 的求值结果（布尔）——loose 放行，schema 只为放行该键存在
  earlyInstall: z.boolean().loose().default(false),
  // 其余未知键不拒绝（forward-compatible）
}).loose()
