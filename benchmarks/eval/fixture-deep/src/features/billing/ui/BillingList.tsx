import type { BillingDto } from '../model/types.js';

export const BillingList = ({ items }: { items: BillingDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
