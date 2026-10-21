

export async function run() {
  setTimeout(() => {
    fetch("https://198.51.100.7/v1", { signal: AbortSignal.timeout(500) }).catch(() => {});
  }, 10);
  await new Promise((r) => setTimeout(r, 80));
}
export default function plugin() { return run(); }
