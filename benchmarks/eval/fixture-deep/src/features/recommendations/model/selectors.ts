import type { RecommendationsDto } from './types.js';

export const selectRecommendationsLabel = (dto: RecommendationsDto): string => dto.label;
