import { describe, expect, it } from 'vitest';
import { computeTotal } from './computeTotal.js';

describe('computeTotal', () => {
  it('multiplies unit price by quantity', () => {
    expect(computeTotal([{ unitPrice: 10, quantity: 3 }])).toBe(30);
  });

  it('sums multiple lines', () => {
    expect(
      computeTotal([
        { unitPrice: 10, quantity: 2 },
        { unitPrice: 5, quantity: 4 },
      ]),
    ).toBe(40);
  });
});
