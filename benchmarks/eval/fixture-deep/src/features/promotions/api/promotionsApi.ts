import type { PromotionsDto } from '../model/types.js';

export async function fetchPromotions(id: string): Promise<PromotionsDto> {
  return { id, label: 'promotions' };
}
