/**
 * 测试共享：定位 DSH 运行时依赖（cordis / cordis-plugin-loader）与真实插件。
 *
 * 开源前这里原本写死了作者机器的绝对路径
 * （`<用户目录>/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules`），
 * 别人 clone 下来必然跑不了。现在按优先级自动探测：
 *
 *   ① 环境变量 `DSH_DEPS`（CI / 特殊安装位置用）
 *   ② 从当前工作目录与脚本位置向上找 `node_modules/@deepseek-ai/cordis`
 *   ③ DSH 的常见安装位置（桌面端依赖目录 / DSH_HOME 下的运行时）
 *
 * 全部落空时抛**可读**错误，而不是返回 undefined 一路传到深层才炸。
 */
import { createRequire } from 'node:module';
import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @returns {string|null} node_modules 目录，或 null */
export function findDshNodeModules() {
  const env = process.env.DSH_DEPS;
  if (env && isRuntimeDeps(env)) return path.resolve(env);

  // ② 从 cwd 与脚本位置向上找
  const bases = [process.cwd(), scriptDir()];
  for (const base of bases) {
    let dir = path.resolve(base);
    for (let i = 0; i < 8; i++) {
      const nm = path.join(dir, 'node_modules');
      if (isRuntimeDeps(nm)) return nm;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // ③ 常见安装位置
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const guesses = [
    path.join(appdata, 'dsh-tauri', 'dependencies', 'dsh', 'node_modules'),
    path.join(home, 'AppData', 'Roaming', 'dsh-tauri', 'dependencies', 'dsh', 'node_modules'),
    path.join(home, '.dsh', 'dependencies', 'dsh', 'node_modules'),
    path.join(home, 'AppData', 'Local', 'deepseek-harness', 'dependencies', 'dsh', 'node_modules'),
    '/usr/local/lib/dsh/node_modules',
    '/opt/dsh/node_modules',
  ];
  for (const g of guesses) if (isRuntimeDeps(g)) return g;
  return null;
}

function scriptDir() {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

function isRuntimeDeps(nm) {
  try {
    return statSync(path.join(nm, '@deepseek-ai', 'cordis')).isDirectory();
  } catch { return false; }
}

/**
 * 通过 Node 解析器找（覆盖面更广：全局安装、pnpm 提升等情况）。
 * @returns {string|null}
 */
export function resolveViaNode(spec = '@deepseek-ai/cordis') {
  const req = createRequire(import.meta.url);
  const bases = [process.cwd(), scriptDir()];
  for (const base of bases) {
    try {
      const resolved = req.resolve(spec, { paths: [base] });
      const idx = resolved.replace(/\\/g, '/').lastIndexOf('/@deepseek-ai/');
      if (idx > 0) return resolved.slice(0, idx).replace(/\//g, path.sep);
    } catch { /* 下一候选 */ }
  }
  return null;
}

/**
 * 取依赖目录；找不到时抛出**可读**错误。
 * @param {string} [what] 用途说明，出现在错误信息里
 */
export function requireDshNodeModules(what = '测试') {
  const nm = findDshNodeModules() ?? resolveViaNode();
  if (!nm) {
    throw new Error(
      `${what} 需要 DSH 运行时依赖（@deepseek-ai/cordis）。\n`
      + '  未找到。请设置环境变量 DSH_DEPS 指向 DSH 的 node_modules 目录，例如：\n'
      + '    PowerShell:  $env:DSH_DEPS = "C:\\path\\to\\dsh\\node_modules"\n'
      + '    bash:        export DSH_DEPS=/path/to/dsh/node_modules\n'
      + '  已尝试：DSH_DEPS、cwd 向上查找、以及 DSH 常见安装位置。',
    );
  }
  return nm;
}

/** DSH_HOME（默认 ~/.dsh），供需要事件日志路径的测试用 */
export function dshHome() {
  return process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
}

/** 事件日志默认路径 */
export function defaultEventLog() {
  return path.join(dshHome(), 'firewall', 'events.jsonl');
}

/** 列出本机所有 profile 目录（按修改时间新→旧） */
export function listProfiles() {
  const root = path.join(dshHome(), 'profiles');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
      .sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
      });
  } catch { return []; }
}

/**
 * 在已安装的 profile 里找一个真实插件目录。
 * 开源后不能写死作者本机的 profile——别人机器上没有，测试必红。
 *
 * @param {string} name 插件包名
 * @returns {string|null}
 */
export function findInstalledPlugin(name) {
  const envDir = process.env.PDR_REAL_PLUGIN_DIR;
  if (envDir && isPluginDir(envDir)) return envDir;

  for (const profile of listProfiles()) {
    const d = path.join(profile, 'node_modules', name);
    if (isPluginDir(d)) return d;
  }
  return null;
}

function isPluginDir(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return true;
  } catch { return false; }
}

/**
 * 给真实插件搭一个临时依赖 overlay。
 *
 * 真实插件的 `import '@deepseek-ai/dsh-llm'` 等依赖由 **DSH 运行时**自带，
 * 不在 profile 的 node_modules 里。直接把 scope 链进用户 profile 会污染用户环境，
 * 所以复制插件到临时目录、再软链 @deepseek-ai scope：
 *
 *   TMP/node_modules/<pkg>         ← 真实插件目录副本
 *   TMP/node_modules/@deepseek-ai  ← 软链到运行时 scope
 *
 * @returns {string|null} overlay 里插件目录；失败返回 null
 */
export function buildPluginOverlay(pluginDir, tmpRoot) {
  const runtimeNM = findDshNodeModules();
  if (!runtimeNM) return null;
  const nm = path.join(tmpRoot, 'node_modules');
  mkdirSync(nm, { recursive: true });
  const pkgName = readPluginName(pluginDir) || path.basename(pluginDir);
  const dest = path.join(nm, pkgName);
  try { cpSync(pluginDir, dest, { recursive: true }); } catch { return null; }
  const scope = path.join(nm, '@deepseek-ai');
  try { symlinkSync(path.join(runtimeNM, '@deepseek-ai'), scope, 'junction'); } catch { return null; }
  return dest;
}

function readPluginName(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { return null; }
}

/** 插件包根目录（从本文件所在 test/ 上跳一级） */
export function packageRoot() {
  return path.resolve(scriptDir(), '..');
}

export { existsSync };
