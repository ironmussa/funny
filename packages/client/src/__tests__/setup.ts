import '@testing-library/jest-dom';
import { afterAll, afterEach, vi } from 'bun:test';

import { cleanup } from '@testing-library/react';

// Polyfill requestIdleCallback / cancelIdleCallback (not in jsdom). Backed by a
// near-zero setTimeout so idle-deferred work (sidebar git status, MCP server
// listing, external-session sync) runs deterministically under both real and
// fake timers in tests, exercising the same code path as the browser.
if (typeof globalThis.requestIdleCallback === 'undefined') {
  const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextIdleId = 1;
  globalThis.requestIdleCallback = (cb: IdleRequestCallback): number => {
    const id = nextIdleId++;
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      // A callback queued just before the test environment tears down (e.g.
      // TanStack DB's idle GC of a live query) must not run without a window.
      if (typeof window === 'undefined') return;
      cb({ didTimeout: false, timeRemaining: () => 0 });
    }, 1);
    idleTimers.set(id, timer);
    return id;
  };
  globalThis.cancelIdleCallback = (id: number): void => {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
  };
}

// Mock ResizeObserver (not available in jsdom/happy-dom)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no canvas: its getContext() logs "Not implemented" and returns
// null. Callers (VirtualDiff's width measurement, pretext warmup, Mermaid
// export) already handle a null context, so return it without the error.
HTMLCanvasElement.prototype.getContext = () => null;

// Polyfill Element.prototype.getAnimations (not in jsdom; used by Base UI popups/transitions)
if (typeof Element !== 'undefined' && typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = () => [];
}

// jsdom's EventTarget.addEventListener rejects Bun's global AbortSignal (Base UI passes
// `new AbortController().signal` in ContextMenuTrigger etc.). Bridge `options.signal` manually
// when native addEventListener rejects it.
if (typeof EventTarget !== 'undefined') {
  const origAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function patchedAddEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (options && typeof options === 'object' && options.signal) {
      const { signal, ...rest } = options;
      if (signal.aborted) return;
      origAddEventListener.call(this, type, listener, rest);
      signal.addEventListener(
        'abort',
        () => {
          this.removeEventListener(type, listener, rest);
        },
        { once: true },
      );
      return;
    }
    return origAddEventListener.call(this, type, listener, options);
  };
}

// Mock window.matchMedia (used by settings-store, main.tsx)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  // Tests replace it (stubGlobal, defineProperty) for other queries.
  configurable: true,
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

// Unmount what each test rendered, as @testing-library/react does on its own
// under vitest's globals.
afterEach(() => {
  cleanup();
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
