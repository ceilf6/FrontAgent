import type { Review } from './review.js';

export const isReview = (value: unknown): value is Review =>
  typeof value === 'object' && value !== null && 'id' in value;
