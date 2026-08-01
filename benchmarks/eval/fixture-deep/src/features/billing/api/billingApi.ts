import type { BillingDto } from '../model/types.js';

export async function fetchBilling(id: string): Promise<BillingDto> {
  return { id, label: 'billing' };
}
