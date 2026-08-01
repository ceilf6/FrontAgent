import type { NotificationsDto } from '../model/types.js';

export async function fetchNotifications(id: string): Promise<NotificationsDto> {
  return { id, label: 'notifications' };
}
