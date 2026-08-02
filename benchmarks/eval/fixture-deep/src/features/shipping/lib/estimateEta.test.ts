import { describe, expect, it } from 'vitest';
import { estimateEta } from './estimateEta.js';

describe('estimateEta', () => {
  it('returns 0 for a non-positive distance', () => {
    expect(estimateEta(0)).toBe(0);
  });

  it('rounds partial days up', () => {
    // 600km spans into a second delivery day
    expect(estimateEta(600)).toBe(2);
  });

  it('treats an exact multiple as a whole number of days', () => {
    expect(estimateEta(1000)).toBe(2);
  });
});
