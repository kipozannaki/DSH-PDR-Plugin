/**
 * 拦截引擎 —— 判定层的执法端（M2 Block 模式）
 *
 * 在被 hook 的 I/O 真正执行**之前**做一次快速判定（预执行检查），
 * 结合 Policy 决定 allow / alarm / block。block 时由探针抛 FirewallBlockError。
 *
 * 覆盖四类越界 + 一类"当场外发"：
 *   capability-deviation   未声明能力类别却调用
 *   target-sensitive       触碰全局凭据/密钥（无 global-credentials 授权）
 *   target-other-plugin    触碰其他插件文件（无 cross-plugin 授权）
 *   destination-scope      封闭契约下连未声明目的地
 *   credential-exfil       凭据触碰后 N 秒内外联（当场外发，无需等红线事后共现）
 *
 * fail-safe：引擎自身任何异常 → 返回 null（放行），绝不拖垮宿主（方案 §6.3）。
 * 注意：这是受控拦截（抛错给插件），不是沙箱；宿主自身与自观测永不进到这里。
 */
import { classifyPath, hostOf, isCredentialTarget } from '../judge/paths.js';
import { apiClassOf, contractAllowsApi, contractAllowsPathClass, contractAllowsHost, deriveContract } from '../judge/contract.js';

const CRED_WINDOW_MS = 60_000; // 凭据触碰→外联 的"当场外发"窗口

/**
 * @param policy       Policy 实例（决定动作）
 * @param getContract  (actor) => contract（判定用契约）
 * @param ownDirs      Map actor -> [dir]（路径分类：自己的目录）
 * @param pluginDirs   Map dir -> actor（路径分类：其他插件目录）
 */
export function createGuard({ policy, getContract, ownDirs = new Map(), pluginDirs = new Map(), clock = Date.now } = {}) {
  const credTouch = new Map(); // actor -> 最近凭据触碰时刻

  function beforeCall(actor, api, target) {
    if (!actor || actor === 'host' || actor === 'self') return null;
    try {
      const contract = (getContract ? getContract(actor) : null) ?? deriveContract({ name: actor });
      const apiClass = apiClassOf(api);
      const now = clock();
      let rule = null;
      let reason = '';

      // ① 当场外发：凭据触碰后短时间内联网（比事后红线共现更早拦截）
      const credNow = isCredentialTarget(target);
      if (credNow) {
        credTouch.set(actor, now);
      } else if (apiClass === 'network' && credTouch.has(actor) && now - credTouch.get(actor) < CRED_WINDOW_MS) {
        rule = 'credential-exfil';
        reason = `凭据触碰后 ${Math.round((now - credTouch.get(actor)) / 1000)}s 内外联（疑似外发）`;
      }

      // ② 能力面越界
      if (!rule && !contractAllowsApi(contract, api)) {
        rule = 'capability-deviation';
        reason = `未声明 ${apiClass} 能力却调用 ${api}`;
      }

      // ③ 目标越界
      if (!rule && String(api).startsWith('fs')) {
        const info = classifyPath(target, {
          ownDirs: ownDirs.get(actor) ?? [],
          pluginDirs,
        });
        if (info.class === 'sensitive' && !contractAllowsPathClass(contract, 'sensitive')) {
          rule = 'target-sensitive';
          reason = '触碰全局凭据/密钥类敏感路径';
        } else if (info.class === 'other-plugin' && !contractAllowsPathClass(contract, 'other-plugin')) {
          rule = 'target-other-plugin';
          reason = `触碰其他插件（${info.detail}）的文件`;
        }
      }

      // ④ 目的地越界（仅封闭契约）
      if (!rule && apiClass === 'network') {
        const host = hostOf(target);
        if (host && !contractAllowsHost(contract, host)) {
          rule = 'destination-scope';
          reason = `连接未声明目的地 ${host}`;
        }
      }

      if (!rule) return null;
      return { action: policy.decide(actor, rule), rule, reason, actor, api, target: String(target ?? '') };
    } catch {
      return null; // fail-safe：引擎异常绝不拦
    }
  }

  return {
    beforeCall,
    /** 清理凭据触碰状态（测试/重置用） */
    reset: () => credTouch.clear(),
  };
}
