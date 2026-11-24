import { useState, type Dispatch, type SetStateAction } from 'react';

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * State that goes back to `initial` whenever one of `resetKeys` changes. It
 * replaces `useState` plus `useEffect(() => setValue(initial), resetKeys)`:
 * the reset happens during render (React's "adjusting state when a prop
 * changes" pattern), so the component never paints the old value and there is
 * no extra commit. The setter is the plain, stable `useState` setter.
 */
export function useResettableState<T>(
  initial: T,
  resetKeys: readonly unknown[],
): [T, Dispatch<SetStateAction<T>>] {
  const [keys, setKeys] = useState(resetKeys);
  const [value, setValue] = useState(initial);
  if (!sameKeys(keys, resetKeys)) {
    setKeys(resetKeys);
    setValue(initial);
    return [initial, setValue];
  }
  return [value, setValue];
}
