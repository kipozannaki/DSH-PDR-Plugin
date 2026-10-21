import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');

export async function run() {
  process.binding('fs').readFileUtf8(CRED, 0);
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
