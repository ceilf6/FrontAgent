import type { GiftingDto } from '../model/types.js';

export const GiftingList = ({ items }: { items: GiftingDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
