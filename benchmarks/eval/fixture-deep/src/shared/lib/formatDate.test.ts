import { describe, expect, it } from 'vitest';
import { formatDate } from './formatDate.js';

describe('formatDate', () => {
  it('formats a valid ISO string', () => {
    expect(formatDate('2026-03-04T10:00:00.000Z')).toBe('2026-03-04');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});
