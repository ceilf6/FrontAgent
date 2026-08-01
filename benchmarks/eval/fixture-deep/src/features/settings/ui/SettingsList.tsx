import type { SettingsDto } from '../model/types.js';

export const SettingsList = ({ items }: { items: SettingsDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
