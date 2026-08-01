import type { WishlistDto } from '../model/types.js';

export const WishlistList = ({ items }: { items: WishlistDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
