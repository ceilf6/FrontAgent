export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth()).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
