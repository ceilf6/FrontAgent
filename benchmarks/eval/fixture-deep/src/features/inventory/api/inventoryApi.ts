import type { InventoryDto } from '../model/types.js';

export async function fetchInventory(id: string): Promise<InventoryDto> {
  return { id, label: 'inventory' };
}
