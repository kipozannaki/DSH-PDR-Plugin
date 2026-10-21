/**
 * 契约仓库 —— 用户侧契约的持久化与优先级
 *
 * 契约来源优先级（判定时从上往下找，命中即止）：
 *   1. 用户覆盖 override   （明确批准/修改过的，最高权威）
 *   2. 推断草案 draft       （推断助手生成，未经确认不生效）
 *   3. manifest 声明        （插件作者在 package.json 里自己写的）
 *   4. 体检卡派生默认       （ensureContract 的懒派生兜底）
 *
 * manifest 只管"合作的插件作者"；第三方老插件的契约只能存我们自己家
 * （$DSH_HOME/firewall/contracts.json）——本仓库就是那个家。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class ContractStore {
  constructor(file) {
    this.file = file;
    this.data = { overrides: {}, drafts: {} };
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { overrides: {}, drafts: {}, ...parsed };
      return true;
    } catch {
      return false;
    }
  }

  save() {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /** 判定用：覆盖优先，草案其次（未确认草案只是候选，不生效） */
  get(name) {
    return this.data.overrides[name] ?? null;
  }

  /** 候选展示用：覆盖或草案 */
  peek(name) {
    return this.data.overrides[name] ?? this.data.drafts[name] ?? null;
  }

  setOverride(name, contract) {
    // 用户动作必须持久化（草案可批量生成，覆盖是单次决策）
    this.data.overrides[name] = { ...contract, source: contract.source ?? 'user-override' };
    this.save();
    return this.data.overrides[name];
  }

  setDraft(name, draft) {
    this.data.drafts[name] = draft;
    return draft;
  }

  /** 确认草案：升级为覆盖（用户点头的动作） */
  adopt(name) {
    const draft = this.data.drafts[name];
    if (!draft) return null;
    const adopted = this.setOverride(name, { ...draft, source: 'user-adopted' });
    delete this.data.drafts[name];
    this.save();
    return adopted;
  }

  reject(name) {
    const draft = this.data.drafts[name];
    delete this.data.drafts[name];
    this.save();
    return draft ?? null;
  }

  list() {
    return {
      overrides: Object.entries(this.data.overrides).map(([name, c]) => ({ name, ...c })),
      drafts: Object.entries(this.data.drafts).map(([name, c]) => ({ name, ...c })),
    };
  }
}
