import type { NotificationsDto } from './types.js';

export const selectNotificationsLabel = (dto: NotificationsDto): string => dto.label;
