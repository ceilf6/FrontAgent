import type { ShippingDto } from '../model/types.js';

export async function fetchShipping(id: string): Promise<ShippingDto> {
  return { id, label: 'shipping' };
}
