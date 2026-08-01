import type { WishlistDto } from './types.js';

export const selectWishlistLabel = (dto: WishlistDto): string => dto.label;
