import type { Refund } from './refund.js';

export const isRefund = (value: unknown): value is Refund =>
  typeof value === 'object' && value !== null && 'id' in value;
