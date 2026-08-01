import type { SettingsDto } from './types.js';

export const selectSettingsLabel = (dto: SettingsDto): string => dto.label;
