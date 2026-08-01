import type { SettingsDto } from '../model/types.js';

export async function fetchSettings(id: string): Promise<SettingsDto> {
  return { id, label: 'settings' };
}
