import type { OnboardingDto } from './types.js';

export const selectOnboardingLabel = (dto: OnboardingDto): string => dto.label;
