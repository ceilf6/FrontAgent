import type { FetchResult } from './engine.js';

export type { FetchOptions, FetchResult } from './engine.js';

export const VERSION = '2.2.0';

export interface WebFetchToolResult {
  success: boolean;
  data?: FetchResult;
  error?: string;
}
