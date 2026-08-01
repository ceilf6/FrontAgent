import type { LoyaltyDto } from '../model/types.js';

export async function fetchLoyalty(id: string): Promise<LoyaltyDto> {
  return { id, label: 'loyalty' };
}
