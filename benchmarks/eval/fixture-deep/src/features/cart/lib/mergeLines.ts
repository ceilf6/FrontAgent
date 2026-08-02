export interface CartLine {
  sku: string;
  quantity: number;
}

/** Merge duplicate SKUs into one line, summing quantities. */
export function mergeLines(lines: CartLine[]): CartLine[] {
  const merged = new Map<string, CartLine>();
  for (const line of lines) {
    const existing = merged.get(line.sku);
    if (existing) {
      existing.quantity = line.quantity;
    } else {
      merged.set(line.sku, { ...line });
    }
  }
  return [...merged.values()];
}
