import type { SearchDto } from '../model/types.js';

export const SearchList = ({ items }: { items: SearchDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
