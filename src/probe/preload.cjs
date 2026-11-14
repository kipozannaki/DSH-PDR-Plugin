/**
 * 预载探针（NODE_OPTIONS="--require …/preload.cjs" 或 --import）
 * 宿主 Node 进程启动即装探针——早于一切 ESM facade 创建与插件 I/O，
 * 彻底绕开"earlyInstall 时序 + ESM facade 快照"两大真机问题。
 *
 * 归因模式默认 'als'（栈归因是性能兜底，不是默认）：
 * M0 终审实测栈归因 +206%~218%，ALS 快路径 +0.6%（见 research/M0开销终审-v0.md）。
 * 可用 PDR_PROBE_MODE=stack|both 手动切回诊断用。
 *
 * v0.3：这里同时留下**可核验的预载痕迹**（markPreload + PDR_PRELOAD_RAN），
 * 健康状态据此把"真的预载过"与"只在插件入口晚装"区分开。
 */
const mode = process.env.PDR_PROBE_MODE || 'als';
const core = require('./probe-core.cjs');

// 先标记再装：boot() 里 "bootstrap 兜底为 bundle" 的逻辑据此不会误判
core.markPreload();
process.env.PDR_PRELOAD_RAN = '1';

core.boot(undefined, mode);
