import type { AnalyticsDto } from './types.js';

export const selectAnalyticsLabel = (dto: AnalyticsDto): string => dto.label;
