import '@testing-library/jest-dom';

// Polyfill requestIdleCallback / cancelIdleCallback (not in jsdom). Backed by a
// near-zero setTimeout so idle-deferred work (sidebar git status, MCP server
// listing, external-session sync) runs deterministically under both real and
// fake timers in tests, exercising the same code path as the browser.
if (typeof globalThis.requestIdleCallback === 'undefined') {
  globalThis.requestIdleCallback = ((cb: (deadline: IdleDeadline) => void) =>
    setTimeout(
      () => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline),
      1,
    ) as unknown as number) as typeof globalThis.requestIdleCallback;
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
