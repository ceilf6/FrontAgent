import type { Product } from './product.js';

export const isProduct = (value: unknown): value is Product =>
  typeof value === 'object' && value !== null && 'id' in value;
