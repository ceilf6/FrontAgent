import type { LoyaltyDto } from '../model/types.js';

export const LoyaltyList = ({ items }: { items: LoyaltyDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
