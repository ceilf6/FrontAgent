import type { ShippingDto } from '../model/types.js';

export const ShippingList = ({ items }: { items: ShippingDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
