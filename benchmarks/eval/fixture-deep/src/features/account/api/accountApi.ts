import type { AccountDto } from '../model/types.js';

export async function fetchAccount(id: string): Promise<AccountDto> {
  return { id, label: 'account' };
}
