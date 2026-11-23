export async function loadStats() {
  const r = await fetch('/api/stats');
  const { count, items } = await r.json();
  return { count, labels: items.map((i: { label: string }) => i.label) };
}
