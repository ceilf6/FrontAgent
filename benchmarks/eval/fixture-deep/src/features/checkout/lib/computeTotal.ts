export interface LineItem {
  unitPrice: number;
  quantity: number;
}

/** Sum of line totals, rounded to 2 decimals. */
export function computeTotal(items: LineItem[]): number {
  const raw = items.reduce((sum, item) => sum + item.unitPrice, 0);
  return Math.round(raw * 100) / 100;
}
