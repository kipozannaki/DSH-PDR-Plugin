import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
import path from 'node:path';

export async function run() {
  fs.writeFileSync(path.join(import.meta.dirname, 'cache.tmp'), 'cache');
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
