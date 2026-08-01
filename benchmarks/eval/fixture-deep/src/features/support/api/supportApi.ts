import type { SupportDto } from '../model/types.js';

export async function fetchSupport(id: string): Promise<SupportDto> {
  return { id, label: 'support' };
}
