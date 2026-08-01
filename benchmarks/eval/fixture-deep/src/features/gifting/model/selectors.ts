import type { GiftingDto } from './types.js';

export const selectGiftingLabel = (dto: GiftingDto): string => dto.label;
