import type { Session } from './session.js';

export const isSession = (value: unknown): value is Session =>
  typeof value === 'object' && value !== null && 'id' in value;
