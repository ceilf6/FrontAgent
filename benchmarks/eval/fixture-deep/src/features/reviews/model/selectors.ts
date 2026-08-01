import type { ReviewsDto } from './types.js';

export const selectReviewsLabel = (dto: ReviewsDto): string => dto.label;
