import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const cp = require('node:child_process');
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  fs.readFileSync(CRED, 'utf8');
    cp.spawnSync(process.execPath, ['-e', '0']);
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
