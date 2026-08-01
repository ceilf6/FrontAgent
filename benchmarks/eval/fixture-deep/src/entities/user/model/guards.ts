import type { User } from './user.js';

export const isUser = (value: unknown): value is User =>
  typeof value === 'object' && value !== null && 'id' in value;
