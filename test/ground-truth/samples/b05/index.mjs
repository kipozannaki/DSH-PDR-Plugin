

export async function run() {
  fetch('http://127.0.0.1:39999/x', { signal: AbortSignal.timeout(500) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
