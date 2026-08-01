import type { CheckoutDto } from '../model/types.js';

export async function fetchCheckout(id: string): Promise<CheckoutDto> {
  return { id, label: 'checkout' };
}
