import type { CartDto } from '../model/types.js';

export async function fetchCart(id: string): Promise<CartDto> {
  return { id, label: 'cart' };
}
