import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { useAdjustOnChange, useResettableState } from '@/hooks/use-resettable-state';

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

describe('useAdjustOnChange', () => {
  test('does not run on mount, runs once per change, in the render that sees it', () => {
    const adjust = vi.fn();
    const { rerender } = renderHook(({ k }) => useAdjustOnChange([k], adjust), {
      initialProps: { k: 'a' },
    });
    expect(adjust).not.toHaveBeenCalled();
    rerender({ k: 'a' });
    expect(adjust).not.toHaveBeenCalled();
    rerender({ k: 'b' });
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  test('state it sets is visible in the same render pass', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ k }) => {
        const [shown, setShown] = useState(k);
        useAdjustOnChange([k], () => setShown(k));
        seen.push(shown);
        return shown;
      },
      { initialProps: { k: 'a' } },
    );
    seen.length = 0;
    rerender({ k: 'b' });
    // React discards the render that set state and renders again before commit.
    expect(result.current).toBe('b');
    expect(seen.at(-1)).toBe('b');
  });
});
