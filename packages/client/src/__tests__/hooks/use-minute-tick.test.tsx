import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useMinuteTick } from '@/hooks/use-minute-tick';

describe('useMinuteTick', () => {
  let currentNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    currentNow = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('shares one clock and refreshes every minute', () => {
    const first = renderHook(() => useMinuteTick());
    const second = renderHook(() => useMinuteTick());

    expect(first.result.current).toBe(Date.now());
    expect(second.result.current).toBe(Date.now());
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      currentNow += 60_000;
      vi.advanceTimersByTime(60_000);
    });

    expect(first.result.current).toBe(Date.now());
    expect(second.result.current).toBe(Date.now());

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('refreshes a stale snapshot when subscribers return', () => {
    const first = renderHook(() => useMinuteTick());
    first.unmount();

    currentNow = new Date('2026-01-01T02:00:00.000Z').getTime();
    const second = renderHook(() => useMinuteTick());

    expect(second.result.current).toBe(Date.now());
    second.unmount();
  });
});
