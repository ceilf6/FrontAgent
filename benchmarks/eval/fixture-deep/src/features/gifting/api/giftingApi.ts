import type { GiftingDto } from '../model/types.js';

export async function fetchGifting(id: string): Promise<GiftingDto> {
  return { id, label: 'gifting' };
}
