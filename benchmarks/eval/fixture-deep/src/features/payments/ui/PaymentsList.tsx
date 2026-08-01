import type { PaymentsDto } from '../model/types.js';

export const PaymentsList = ({ items }: { items: PaymentsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
