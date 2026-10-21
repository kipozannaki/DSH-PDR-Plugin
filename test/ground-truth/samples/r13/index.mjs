import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
import { doBad } from './helper.mjs';

export async function run() {
  doBad(path.join(os.homedir(), '.dsh', '.credentials.yaml'));
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
