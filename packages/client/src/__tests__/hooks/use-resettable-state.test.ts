import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { useResettableState } from '@/hooks/use-resettable-state';

describe('useResettableState', () => {
  test('keeps a set value while the keys stay the same', () => {
    const { result, rerender } = renderHook(({ k }) => useResettableState(false, [k]), {
      initialProps: { k: 'a' },
    });
    act(() => result.current[1](true));
    rerender({ k: 'a' });
    expect(result.current[0]).toBe(true);
  });

  test('returns the initial value in the same render the keys change', () => {
    const seen: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ k }) => {
        const state = useResettableState(false, [k]);
        seen.push(state[0]);
        return state;
      },
      { initialProps: { k: 'a' } },
    );
    act(() => result.current[1](true));
    seen.length = 0;
    rerender({ k: 'b' });
    expect(seen.every((v) => v === false)).toBe(true);
    expect(result.current[0]).toBe(false);
  });

  test('uses the current initial value on reset and keeps the setter stable', () => {
    const { result, rerender } = renderHook(({ k, init }) => useResettableState(init, [k]), {
      initialProps: { k: 'a', init: 1 },
    });
    const setter = result.current[1];
    act(() => setter((v) => v + 10));
    expect(result.current[0]).toBe(11);
    rerender({ k: 'b', init: 5 });
    expect(result.current[0]).toBe(5);
    expect(result.current[1]).toBe(setter);
  });
});
