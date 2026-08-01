import type { CartDto } from '../model/types.js';

export const CartList = ({ items }: { items: CartDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
