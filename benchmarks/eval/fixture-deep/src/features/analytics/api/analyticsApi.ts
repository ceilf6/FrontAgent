import type { AnalyticsDto } from '../model/types.js';

export async function fetchAnalytics(id: string): Promise<AnalyticsDto> {
  return { id, label: 'analytics' };
}
