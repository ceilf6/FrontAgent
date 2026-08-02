/** ISO date string -> YYYY-MM-DD. Returns an empty string for invalid input. */
export function formatDate(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
