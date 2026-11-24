/**
 * Types for the globals the e2e specs install in the page (init scripts and
 * the WebSocket capture in mock-helpers.ts) and for the Chromium-only APIs
 * they read. Import it for its types: `import './browser-globals';`.
 */

interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserShiftSource {
  tag: string;
  className: string;
  testId: string | null;
  previousRect: BrowserRect | null;
  currentRect: BrowserRect | null;
}

interface BrowserStartupWebVitals {
  lcp: number | null;
  lcpElement: { tag: string; className: string; testId: string | null } | null;
  layoutShifts: Array<{
    startTime: number;
    value: number;
    hadRecentInput: boolean;
    sources: BrowserShiftSource[];
  }>;
  longTasks: Array<{ startTime: number; duration: number }>;
}

declare global {
  interface Window {
    threadViewerLayoutShifts?: Array<{ value: number; hadRecentInput: boolean }>;
    startupWebVitals?: BrowserStartupWebVitals;
    promptKeyboardPaints?: Array<{ key: string; duration: number }>;
    promptKeyboardEvents?: Array<{ name: string; duration: number }>;
    __playwright_ws_instances?: WebSocket[];
    /** Exposed by Chromium only with `--js-flags=--expose-gc`. */
    gc?: () => void;
  }

  /** Chromium's non-standard `performance.memory`. */
  interface Performance {
    memory?: { usedJSHeapSize: number };
  }

  /** Layout Instability API (Chromium), not in TypeScript's DOM lib. */
  interface LayoutShiftAttribution {
    readonly node: Node | null;
    readonly previousRect: DOMRectReadOnly;
    readonly currentRect: DOMRectReadOnly;
  }

  interface LayoutShift extends PerformanceEntry {
    readonly value: number;
    readonly hadRecentInput: boolean;
    readonly sources: readonly LayoutShiftAttribution[];
  }

  var LayoutShift: { prototype: LayoutShift; new (): LayoutShift };
}

// A module, so `declare global` above augments the global scope.
export {};
