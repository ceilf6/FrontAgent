import type { CompareDto } from '../model/types.js';

export const CompareList = ({ items }: { items: CompareDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
