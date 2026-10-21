import { execSync } from 'node:child_process';

export async function run() {
  execSync('node -e "0"');
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
