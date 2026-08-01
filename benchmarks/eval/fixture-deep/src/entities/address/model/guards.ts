import type { Address } from './address.js';

export const isAddress = (value: unknown): value is Address =>
  typeof value === 'object' && value !== null && 'id' in value;
