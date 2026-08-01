export function format(value: number): string {
  return `billing:${value.toFixed(2)}`;
}
