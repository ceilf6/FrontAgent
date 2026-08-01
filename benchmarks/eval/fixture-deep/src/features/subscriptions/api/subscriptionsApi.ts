import type { SubscriptionsDto } from '../model/types.js';

export async function fetchSubscriptions(id: string): Promise<SubscriptionsDto> {
  return { id, label: 'subscriptions' };
}
