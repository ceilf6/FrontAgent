import type { SupportDto } from '../model/types.js';

export const SupportList = ({ items }: { items: SupportDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
