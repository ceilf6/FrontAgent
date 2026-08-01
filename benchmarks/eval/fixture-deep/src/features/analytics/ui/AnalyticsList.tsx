import type { AnalyticsDto } from '../model/types.js';

export const AnalyticsList = ({ items }: { items: AnalyticsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
