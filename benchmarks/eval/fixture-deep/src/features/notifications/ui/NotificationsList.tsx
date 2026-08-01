import type { NotificationsDto } from '../model/types.js';

export const NotificationsList = ({ items }: { items: NotificationsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
