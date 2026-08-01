import type { RecommendationsDto } from '../model/types.js';

export async function fetchRecommendations(id: string): Promise<RecommendationsDto> {
  return { id, label: 'recommendations' };
}
