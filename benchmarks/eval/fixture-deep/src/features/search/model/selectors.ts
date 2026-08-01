import type { SearchDto } from './types.js';

export const selectSearchLabel = (dto: SearchDto): string => dto.label;
