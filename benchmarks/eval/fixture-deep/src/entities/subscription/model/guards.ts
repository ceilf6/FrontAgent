import type { Subscription } from './subscription.js';

export const isSubscription = (value: unknown): value is Subscription =>
  typeof value === 'object' && value !== null && 'id' in value;
