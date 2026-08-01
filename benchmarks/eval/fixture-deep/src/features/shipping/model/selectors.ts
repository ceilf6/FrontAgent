import type { ShippingDto } from './types.js';

export const selectShippingLabel = (dto: ShippingDto): string => dto.label;
