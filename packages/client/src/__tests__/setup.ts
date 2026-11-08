import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterAll, vi } from 'vitest';

// Polyfill requestIdleCallback / cancelIdleCallback (not in jsdom). Backed by a
// near-zero setTimeout so idle-deferred work (sidebar git status, MCP server
// listing, external-session sync) runs deterministically under both real and
// fake timers in tests, exercising the same code path as the browser.
if (typeof globalThis.requestIdleCallback === 'undefined') {
  globalThis.requestIdleCallback = ((cb: (deadline: IdleDeadline) => void) =>
    setTimeout(() => {
      // A callback queued just before the test environment tears down (e.g.
      // TanStack DB's idle GC of a live query) must not run without a window.
      if (typeof window === 'undefined') return;
      cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    }, 1) as unknown as number) as typeof globalThis.requestIdleCallback;
  globalThis.cancelIdleCallback = ((id: number) =>
    clearTimeout(id)) as typeof globalThis.cancelIdleCallback;
}

// Mock ResizeObserver (not available in jsdom/happy-dom)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

// Mock window.matchMedia (used by settings-store, main.tsx)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Radix FocusScope dispatches a CustomEvent from a setTimeout(0) when it
// unmounts. On a loaded machine that timer can outlive the file's jsdom
// environment and throw "parameter 1 is not of type 'Event'" as an unhandled
// error, failing the run even though every test passed. Unmount what is left
// and let pending zero-delay timers run while the window still exists.
afterAll(async () => {
  vi.useRealTimers();
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 10));
});
