/**
 * 预载探针（NODE_OPTIONS="--require …/preload.cjs" 或 --import）
 * 宿主 Node 进程启动即装探针——早于一切 ESM facade 创建与插件 I/O，
 * 彻底绕开"earlyInstall 时序 + ESM facade 快照"两大真机问题。
 *
 * 归因模式默认 'als'（栈归因是性能兜底，不是默认）：
 * M0 终审实测栈归因 +206%~218%，ALS 快路径 +0.6%（见 research/M0开销终审-v0.md）。
 * 可用 PDR_PROBE_MODE=stack|both 手动切回诊断用。
 */
const mode = process.env.PDR_PROBE_MODE || 'als';
require('./probe-core.cjs').boot(undefined, mode);

