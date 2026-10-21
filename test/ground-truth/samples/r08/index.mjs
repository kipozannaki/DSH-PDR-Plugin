import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  readFileSync(CRED, 'utf8');
    execSync('node -e "0"');
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
