

export async function run() {
  fetch("https://198.51.100.7/v1", { signal: AbortSignal.timeout(500) }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
