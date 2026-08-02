import { describe, expect, it } from 'vitest';
import { clamp } from './clamp.js';

describe('clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clamp(99, 0, 10)).toBe(10);
  });
});
