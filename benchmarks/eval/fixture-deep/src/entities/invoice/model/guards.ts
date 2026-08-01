import type { Invoice } from './invoice.js';

export const isInvoice = (value: unknown): value is Invoice =>
  typeof value === 'object' && value !== null && 'id' in value;
