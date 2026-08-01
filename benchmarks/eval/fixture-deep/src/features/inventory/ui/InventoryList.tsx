import type { InventoryDto } from '../model/types.js';

export const InventoryList = ({ items }: { items: InventoryDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
