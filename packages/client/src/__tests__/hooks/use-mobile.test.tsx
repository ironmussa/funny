import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsMobile } from '@/hooks/use-mobile';

describe('useIsMobile', () => {
  let matches: boolean;
  let listeners: Set<() => void>;

  beforeEach(() => {
    matches = false;
    listeners = new Set();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('tracks the mobile media query and unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
    expect(listeners).toHaveLength(1);

    act(() => {
      matches = true;
      listeners.forEach((listener) => listener());
    });

    expect(result.current).toBe(true);

    unmount();
    expect(listeners).toHaveLength(0);
  });
});
