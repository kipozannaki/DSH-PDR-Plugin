/**
 * 定位 DSH 运行时依赖（cordis / cordis-plugin-loader）。
 *
 * 为什么需要：隔离试装要在**子进程**里用真实 cordis 启动插件，而 cordis 是
 * DSH 宿主自带的依赖，不在插件自己的 node_modules 里。子进程拿不到宿主的模块解析链，
 * 所以路径必须显式传进去——**绝不能写死某个人的安装路径**（那样别人机器上试装必然失败）。
 *
 * 解析优先级：
 *   ① 环境变量 `DSH_DEPS`（父进程会设，见 trial.js）
 *   ② 从 `require.cache` 里反推：宿主已经把 cordis 加载进来了，路径就是权威答案
 *   ③ 常见安装位置（桌面端 / 本地安装）
 *
 * @returns {string|null} node_modules 目录，找不到返回 null
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';

export function resolveDshNodeModules() {
  const fromEnv = process.env.DSH_DEPS;
  if (fromEnv && hasCordis(fromEnv)) return path.resolve(fromEnv);

  // ② 宿主已加载 cordis —— 从模块缓存反推最可靠
  try {
    const cache = createRequire(import.meta.url).cache || {};
    for (const file of Object.keys(cache)) {
      const norm = file.replace(/\\/g, '/');
      const idx = norm.lastIndexOf('/@deepseek-ai/cordis/');
      if (idx > 0) {
        const nm = norm.slice(0, idx);
        if (hasCordis(nm)) return nm.replace(/\//g, path.sep);
      }
    }
  } catch { /* 下一个来源 */ }

  // ③ 常见安装位置
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appdata = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
  const guesses = [
    appdata && path.join(appdata, 'dsh-tauri', 'dependencies', 'dsh', 'node_modules'),
    home && path.join(home, 'AppData', 'Roaming', 'dsh-tauri', 'dependencies', 'dsh', 'node_modules'),
    home && path.join(home, 'AppData', 'Local', 'deepseek-harness', 'dependencies', 'dsh', 'node_modules'),
    home && path.join(home, '.dsh', 'dependencies', 'dsh', 'node_modules'),
    '/usr/local/lib/dsh/node_modules',
    '/opt/dsh/node_modules',
  ].filter(Boolean);
  for (const g of guesses) if (hasCordis(g)) return g;
  return null;
}

function hasCordis(nm) {
  try { return statSync(path.join(nm, '@deepseek-ai', 'cordis')).isDirectory(); } catch { return false; }
}
