import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  fs.readFileSync(CRED, 'utf8');
    cp.execSync('node -e "0"');
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
