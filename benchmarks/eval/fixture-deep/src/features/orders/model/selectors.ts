import type { OrdersDto } from './types.js';

export const selectOrdersLabel = (dto: OrdersDto): string => dto.label;
