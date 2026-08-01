import type { SubscriptionsDto } from '../model/types.js';

export const SubscriptionsList = ({ items }: { items: SubscriptionsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
