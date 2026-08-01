import type { InventoryDto } from './types.js';

export const selectInventoryLabel = (dto: InventoryDto): string => dto.label;
