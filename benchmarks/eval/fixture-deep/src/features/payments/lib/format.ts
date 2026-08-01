export function format(value: number): string {
  return `payments:${value.toFixed(2)}`;
}
