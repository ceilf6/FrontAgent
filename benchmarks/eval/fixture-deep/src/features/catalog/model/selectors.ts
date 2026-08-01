import type { CatalogDto } from './types.js';

export const selectCatalogLabel = (dto: CatalogDto): string => dto.label;
