import type { AccountDto } from './types.js';

export const selectAccountLabel = (dto: AccountDto): string => dto.label;
