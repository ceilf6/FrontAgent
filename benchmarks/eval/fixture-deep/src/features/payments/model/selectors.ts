import type { PaymentsDto } from './types.js';

export const selectPaymentsLabel = (dto: PaymentsDto): string => dto.label;
