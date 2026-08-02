import { describe, expect, it } from 'vitest';
import { pluralize } from './pluralize.js';

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'item')).toBe('item');
  });

  it('uses the plural otherwise', () => {
    expect(pluralize(2, 'item')).toBe('items');
    expect(pluralize(0, 'item')).toBe('items');
  });

  it('honours an explicit plural', () => {
    expect(pluralize(3, 'person', 'people')).toBe('people');
  });
});
