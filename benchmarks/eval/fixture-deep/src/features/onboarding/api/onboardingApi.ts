import type { OnboardingDto } from '../model/types.js';

export async function fetchOnboarding(id: string): Promise<OnboardingDto> {
  return { id, label: 'onboarding' };
}
