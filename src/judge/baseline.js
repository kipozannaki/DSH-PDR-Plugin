/**
 * 行为基线 —— "它平时干什么"的统计画像
 *
 * 学习期（默认前 50 个事件）只记录不告警；学完后偏移才记（info 级）：
 *   new-destination  出现从未见过的外联目的地
 *   odd-hour         本地 0-5 点静默时段的网络行为（方案 §4.1② 的"凌晨静默外联"）
 *   rate-spike       十分钟窗口事件数超过学习期均值的 5 倍 + 5
 *   new-path-class   出现从未用过的路径类别
 * 设计原则：基线类只到"观察"级——它提示反常，不指控恶意。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  learningEvents: 50,
  quietHours: [0, 1, 2, 3, 4],
  windowMs: 10 * 60_000,
  spikeFactor: 5,
  spikeBase: 5,
};

export class Baseline {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.actors = new Map(); // actor -> profile
  }

  #profile(actor) {
    let p = this.actors.get(actor);
    if (!p) {
      p = {
        events: 0,
        firstSeen: 0,
        lastSeen: 0,
        hosts: [],
        pathClasses: [],
        hours: Array(24).fill(0),
        windowStart: 0,
        windowCount: 0,
        learnedPerWindow: 0,
      };
      this.actors.set(actor, p);
    }
    return p;
  }

  /** 记录一个事件，返回基线类偏移（学习期内恒为空） */
  observe(event, extra = {}) {
    const p = this.#profile(event.actor);
    const deviations = [];
    const learning = p.events < this.opts.learningEvents;

    const host = extra.host ?? '';
    const pathClass = extra.pathClass ?? 'unknown';
    const hour = new Date(event.t ?? Date.now()).getHours();

    // 窗口计数（频率突增用）
    const t = event.t ?? Date.now();
    if (t - p.windowStart > this.opts.windowMs) {
      if (p.windowCount > 0) {
        p.learnedPerWindow = p.learnedPerWindow === 0
          ? p.windowCount
          : Math.round((p.learnedPerWindow * 2 + p.windowCount) / 3);
      }
      p.windowStart = t;
      p.windowCount = 0;
    }
    p.windowCount++;

    if (!learning) {
      if (host && !p.hosts.includes(host)) deviations.push({ rule: 'baseline-new-destination', detail: host });
      if (this.opts.quietHours.includes(hour) && apiIsNetwork(event.api)) {
        deviations.push({ rule: 'baseline-odd-hour', detail: `${hour}:00` });
      }
      if (pathClass !== 'unknown' && !p.pathClasses.includes(pathClass)) {
        deviations.push({ rule: 'baseline-new-path-class', detail: pathClass });
      }
      const limit = (p.learnedPerWindow || 1) * this.opts.spikeFactor + this.opts.spikeBase;
      if (p.windowCount === limit) deviations.push({ rule: 'baseline-rate-spike', detail: `${p.windowCount}/10min` });
    }

    // 更新画像（学习期积累 + 长期缓慢吸收新常态）
    if (host && !p.hosts.includes(host)) p.hosts.push(host);
    if (pathClass !== 'unknown' && !p.pathClasses.includes(pathClass)) p.pathClasses.push(pathClass);
    p.hours[hour]++;
    p.events++;
    p.firstSeen = p.firstSeen || t;
    p.lastSeen = t;
    return deviations;
  }

  stats(actor) {
    const p = this.actors.get(actor);
    if (!p) return null;
    return {
      events: p.events,
      learning: p.events < this.opts.learningEvents,
      hosts: [...p.hosts],
      pathClasses: [...p.pathClasses],
      quietHourEvents: this.opts.quietHours.reduce((n, h) => n + p.hours[h], 0),
    };
  }

  save(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ opts: this.opts, actors: [...this.actors.entries()] }));
  }

  load(file) {
    if (!existsSync(file)) return false;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.opts = { ...this.opts, ...data.opts };
      this.actors = new Map(data.actors);
      return true;
    } catch {
      return false;
    }
  }
}

function apiIsNetwork(api) {
  return /^fetch|^https?:|^net\.|^(http|https)\./.test(String(api));
}
