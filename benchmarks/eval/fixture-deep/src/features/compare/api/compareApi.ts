import type { CompareDto } from '../model/types.js';

export async function fetchCompare(id: string): Promise<CompareDto> {
  return { id, label: 'compare' };
}
