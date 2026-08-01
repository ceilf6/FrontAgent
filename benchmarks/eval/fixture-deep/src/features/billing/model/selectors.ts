import type { BillingDto } from './types.js';

export const selectBillingLabel = (dto: BillingDto): string => dto.label;
