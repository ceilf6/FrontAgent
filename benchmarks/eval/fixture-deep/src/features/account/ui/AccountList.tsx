import type { AccountDto } from '../model/types.js';

export const AccountList = ({ items }: { items: AccountDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
