import type { SearchDto } from '../model/types.js';

export async function fetchSearch(id: string): Promise<SearchDto> {
  return { id, label: 'search' };
}
