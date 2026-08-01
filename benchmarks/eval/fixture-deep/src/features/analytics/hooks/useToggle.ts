import { useState } from 'react';

export function useToggle(initial = false): [boolean, () => void] {
  const [on, setOn] = useState(initial);
  return [on, () => setOn((prev) => !prev)];
}
