import type { Category } from './category.js';

export const isCategory = (value: unknown): value is Category =>
  typeof value === 'object' && value !== null && 'id' in value;
