

export async function run() {
  
  await new Promise((r) => setTimeout(r, 20));
}
export default function plugin() { return run(); }
