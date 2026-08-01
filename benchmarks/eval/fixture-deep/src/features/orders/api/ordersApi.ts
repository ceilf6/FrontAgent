import type { OrdersDto } from '../model/types.js';

export async function fetchOrders(id: string): Promise<OrdersDto> {
  return { id, label: 'orders' };
}
