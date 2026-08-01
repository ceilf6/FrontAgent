import type { RecommendationsDto } from '../model/types.js';

export const RecommendationsList = ({ items }: { items: RecommendationsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
