import type { WishlistDto } from '../model/types.js';

export async function fetchWishlist(id: string): Promise<WishlistDto> {
  return { id, label: 'wishlist' };
}
