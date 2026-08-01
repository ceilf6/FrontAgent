import type { ReviewsDto } from '../model/types.js';

export const ReviewsList = ({ items }: { items: ReviewsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
