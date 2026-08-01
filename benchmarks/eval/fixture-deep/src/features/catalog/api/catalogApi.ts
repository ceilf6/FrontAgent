import type { CatalogDto } from '../model/types.js';

export async function fetchCatalog(id: string): Promise<CatalogDto> {
  return { id, label: 'catalog' };
}
