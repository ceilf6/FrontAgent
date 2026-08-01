import type { ReturnsDto } from '../model/types.js';

export const ReturnsList = ({ items }: { items: ReturnsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
