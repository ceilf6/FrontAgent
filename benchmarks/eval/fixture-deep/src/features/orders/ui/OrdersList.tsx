import type { OrdersDto } from '../model/types.js';

export const OrdersList = ({ items }: { items: OrdersDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
