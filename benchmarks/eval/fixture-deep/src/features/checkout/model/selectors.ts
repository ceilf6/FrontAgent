import type { CheckoutDto } from './types.js';

export const selectCheckoutLabel = (dto: CheckoutDto): string => dto.label;
