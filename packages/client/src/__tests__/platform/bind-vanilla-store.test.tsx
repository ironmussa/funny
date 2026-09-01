import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { bindVanillaStore } from '@/platform/bind-vanilla-store';

describe('bindVanillaStore', () => {
  test('supports whole-state and selected-state subscriptions', () => {
    const store = createStore(() => ({ count: 1, label: 'ready' }));
    const useBoundStore = bindVanillaStore(store);
    const wholeState = renderHook(() => useBoundStore());
    const selectedState = renderHook(() => useBoundStore((state) => state.count));

    expect(wholeState.result.current).toEqual({ count: 1, label: 'ready' });
    expect(selectedState.result.current).toBe(1);

    act(() => store.setState({ count: 2 }));

    expect(wholeState.result.current).toEqual({ count: 2, label: 'ready' });
    expect(selectedState.result.current).toBe(2);
  });
});
