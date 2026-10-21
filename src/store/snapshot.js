/**
 * 快照 / 回滚（方案 §4.1③ 的 MVP 最小版）
 * 快照对象：profile 的清单与补丁（package.json / pnpm-lock.yaml / cordis.patch.yml）
 * —— 插件增删改的"案发现场"三件套；恢复 = 这三件套归位（依赖树靠 pnpm install 对齐）。
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];

export function snapshotProfile({ profileDir, dataDir, tag = '' }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}${tag ? '-' + tag : ''}`;
  const dir = path.join(dataDir, 'snapshots', id);
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of SNAPSHOT_FILES) {
    const src = path.join(profileDir, name);
    if (existsSync(src)) {
      copyFileSync(src, path.join(dir, name));
      files.push(name);
    }
  }
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, profileDir, files, at: Date.now() }, null, 2));
  return { id, dir, files };
}

export function listSnapshots({ dataDir }) {
  const root = path.join(dataDir, 'snapshots');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        return JSON.parse(readFileSync(path.join(root, e.name, 'meta.json'), 'utf8'));
      } catch {
        return { id: e.name, files: [] };
      }
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

export function restoreSnapshot({ dataDir, profileDir, id, dryRun = false }) {
  const dir = path.join(dataDir, 'snapshots', id);
  const metaPath = path.join(dir, 'meta.json');
  if (!existsSync(metaPath)) return { ok: false, error: 'unknown-snapshot', id };
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const restored = [];
  for (const name of meta.files || []) {
    const src = path.join(dir, name);
    const dest = path.join(profileDir, name);
    if (!existsSync(src)) continue;
    if (dryRun) { restored.push(name); continue; }
    // 现场保护：恢复前把当前文件挪进 .pre-restore 备份
    if (existsSync(dest)) {
      const bakDir = path.join(dir, '.pre-restore');
      mkdirSync(bakDir, { recursive: true });
      copyFileSync(dest, path.join(bakDir, name));
    }
    copyFileSync(src, dest);
    restored.push(name);
  }
  return { ok: true, id, restored, dryRun };
}

/** 完整删除某快照（含备份） */
export function deleteSnapshot({ dataDir, id }) {
  const dir = path.join(dataDir, 'snapshots', id);
  if (!existsSync(dir)) return { ok: false, error: 'unknown-snapshot' };
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}
