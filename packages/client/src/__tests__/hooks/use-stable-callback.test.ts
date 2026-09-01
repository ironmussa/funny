import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useStableCallback } from '@/hooks/use-stable-callback';

describe('useStableCallback', () => {
  test('keeps its identity while invoking the latest committed callback', () => {
    const initialCallback = vi.fn((value: number) => value + 1);
    const nextCallback = vi.fn((value: number) => value + 2);
    const { result, rerender } = renderHook(
      ({ callback }: { callback: (value: number) => number }) => useStableCallback(callback),
      { initialProps: { callback: initialCallback } },
    );
    const stableCallback = result.current;

    expect(stableCallback(1)).toBe(2);

    rerender({ callback: nextCallback });

    expect(result.current).toBe(stableCallback);
    expect(stableCallback(1)).toBe(3);
    expect(initialCallback).toHaveBeenCalledOnce();
    expect(nextCallback).toHaveBeenCalledOnce();
  });
});
