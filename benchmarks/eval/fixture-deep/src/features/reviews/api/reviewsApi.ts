import type { ReviewsDto } from '../model/types.js';

export async function fetchReviews(id: string): Promise<ReviewsDto> {
  return { id, label: 'reviews' };
}
