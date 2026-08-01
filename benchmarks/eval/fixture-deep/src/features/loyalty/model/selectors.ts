import type { LoyaltyDto } from './types.js';

export const selectLoyaltyLabel = (dto: LoyaltyDto): string => dto.label;
