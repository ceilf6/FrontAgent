import type { OnboardingDto } from '../model/types.js';

export const OnboardingList = ({ items }: { items: OnboardingDto[] }) => (
  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
);
