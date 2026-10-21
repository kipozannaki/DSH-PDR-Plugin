import fs from 'node:fs';
import path from 'node:path';

export async function run() {
  fs.writeFileSync(path.join(import.meta.dirname, 'cache.tmp'), 'cache');
    fs.readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8');
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
