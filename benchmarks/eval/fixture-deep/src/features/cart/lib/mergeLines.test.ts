import { describe, expect, it } from 'vitest';
import { mergeLines } from './mergeLines.js';

describe('mergeLines', () => {
  it('sums quantities for duplicate SKUs', () => {
    expect(mergeLines([
      { sku: 'A', quantity: 2 },
      { sku: 'A', quantity: 3 },
    ])).toEqual([{ sku: 'A', quantity: 5 }]);
  });

  it('keeps distinct SKUs separate', () => {
    expect(mergeLines([
      { sku: 'A', quantity: 1 },
      { sku: 'B', quantity: 1 },
    ])).toHaveLength(2);
  });
});
