import type { Order } from './order.js';

export const isOrder = (value: unknown): value is Order =>
  typeof value === 'object' && value !== null && 'id' in value;
