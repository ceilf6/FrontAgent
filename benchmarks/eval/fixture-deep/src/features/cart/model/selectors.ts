import type { CartDto } from './types.js';

export const selectCartLabel = (dto: CartDto): string => dto.label;
