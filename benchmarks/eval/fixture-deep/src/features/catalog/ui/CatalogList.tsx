import type { CatalogDto } from '../model/types.js';

export const CatalogList = ({ items }: { items: CatalogDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
