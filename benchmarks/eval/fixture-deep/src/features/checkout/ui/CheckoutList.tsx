import type { CheckoutDto } from '../model/types.js';

export const CheckoutList = ({ items }: { items: CheckoutDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
