/**
 * 本地优先的 JSONL 事件存储（方案 §5.4：不上传任何遥测，审计数据只在本机）
 * 滚动保留：events.jsonl 达到 maxBytes 后轮转，保留 keep 份。
 */
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function createJsonlStore({ dir, fileName = 'events.jsonl', maxBytes = 8 * 1024 * 1024, keep = 3 }) {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  let written = 0;

  function rotate() {
    // 保留 keep 份历史：先删最旧，再依次后移，当前文件归位 .1
    const oldest = `${filePath}.${keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      if (existsSync(from)) renameSync(from, `${filePath}.${i + 1}`);
    }
    if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
  }

  function append(event) {
    try {
      if (existsSync(filePath) && statSync(filePath).size >= maxBytes) rotate();
      appendFileSync(filePath, JSON.stringify(event) + '\n');
      written++;
    } catch {
      // fail-safe：存储失败不得影响观测（方案 §6.3）
    }
  }

  return { append, path: filePath, get written() { return written; }, rotate };
}
