import type { PromotionsDto } from '../model/types.js';

export const PromotionsList = ({ items }: { items: PromotionsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
