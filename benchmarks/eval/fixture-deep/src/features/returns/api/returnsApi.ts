import type { ReturnsDto } from '../model/types.js';

export async function fetchReturns(id: string): Promise<ReturnsDto> {
  return { id, label: 'returns' };
}
