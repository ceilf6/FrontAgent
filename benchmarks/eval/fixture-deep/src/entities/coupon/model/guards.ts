import type { Coupon } from './coupon.js';

export const isCoupon = (value: unknown): value is Coupon =>
  typeof value === 'object' && value !== null && 'id' in value;
