import type { PaymentsDto } from '../model/types.js';

export async function fetchPayments(id: string): Promise<PaymentsDto> {
  return { id, label: 'payments' };
}
