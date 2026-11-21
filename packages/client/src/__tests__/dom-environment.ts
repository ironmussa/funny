/**
 * Preloaded by `bun test` (bunfig.toml) before `setup.ts`: gives every test
 * file a jsdom window as its global scope, as vitest's `environment: 'jsdom'`
 * did. With `--isolate` / `--parallel` each file gets a fresh global object,
 * so this runs again per file and no DOM state leaks between files.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});
const win = dom.window;
const has = (key: string): boolean => Reflect.has(globalThis, key);
const assign = (key: string, value: unknown): void => {
  Reflect.set(globalThis, key, value);
};

// Keys whose Bun implementation must win over jsdom's: the runtime's own
// networking, timers, encoding and streams, which the code under test and the
// test runner both use.
const KEEP_BUN = new Set([
  'fetch',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'Blob',
  'File',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'WebSocket',
  'crypto',
  'performance',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'console',
  'process',
  'Buffer',
]);

for (const key of Object.getOwnPropertyNames(win)) {
  if (KEEP_BUN.has(key) || key === 'window' || key === 'self' || key === 'globalThis') continue;
  if (has(key) && !/^(HTML|SVG|DOM|Event|CustomEvent|Node|Element|Document)/.test(key)) {
    // Prefer Bun's built-ins (Event, EventTarget, etc. are DOM-specific and
    // are taken from jsdom by the pattern above).
    if (
      ![
        'document',
        'navigator',
        'location',
        'localStorage',
        'sessionStorage',
        'history',
        'getComputedStyle',
        'matchMedia',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ].includes(key)
    )
      continue;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(win, key);
    if (!descriptor) continue;
    assign(key, 'value' in descriptor ? descriptor.value : descriptor.get?.call(win));
  } catch {
    // Some window properties are read-only on Bun's global; keep Bun's.
  }
}

assign('window', globalThis);
assign('self', globalThis);

// A failing matcher prints its received value with Bun's inspector, which walks
// a jsdom node's whole object graph (document, window, every property): 26 MB
// for a small <div>, about 2 s for a dialog. A `waitFor` whose first polls fail
// pays that on every poll while blocking the event loop, so the test times out
// under load. Print a node as its markup instead.
const MAX_INSPECTED_MARKUP = 300;
Reflect.set(win.Node.prototype, Symbol.for('nodejs.util.inspect.custom'), function (this: Node) {
  const markup = this instanceof win.Element ? this.outerHTML : this.nodeName;
  return markup.length > MAX_INSPECTED_MARKUP
    ? `${markup.slice(0, MAX_INSPECTED_MARKUP)}…`
    : markup;
});

// `window` is Bun's global, an EventTarget of its own whose dispatchEvent
// rejects jsdom's Event / CustomEvent ("must be an instance of Event"), and
// which never sees the DOM events that bubble from `document` to jsdom's
// window. Route window events to the jsdom window.
const jsdomWindow: EventTarget = dom.window;
for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) {
  assign(method, jsdomWindow[method].bind(jsdomWindow));
}

// Bun's Blob / File are kept (fetch and Response produce them), but jsdom's
// FileReader rejects any Blob it did not create. Copy a Bun Blob into a jsdom
// one before reading it.
const JsdomBlob: typeof Blob = dom.window.Blob;
const JsdomFileReader: typeof FileReader = dom.window.FileReader;

class BunBlobFileReader extends JsdomFileReader {
  private readVia(blob: Blob, read: (jsdomBlob: Blob) => void): void {
    if (blob instanceof JsdomBlob) {
      read(blob);
      return;
    }
    // A Bun Blob (TypeScript sees one Blob type, so it narrows this to never).
    const bunBlob: Blob = blob;
    void bunBlob
      .arrayBuffer()
      .then((buffer) => read(new JsdomBlob([buffer], { type: bunBlob.type })));
  }
  override readAsDataURL(blob: Blob): void {
    this.readVia(blob, (jsdomBlob) => super.readAsDataURL(jsdomBlob));
  }
  override readAsText(blob: Blob, encoding?: string): void {
    this.readVia(blob, (jsdomBlob) => super.readAsText(jsdomBlob, encoding));
  }
  override readAsArrayBuffer(blob: Blob): void {
    this.readVia(blob, (jsdomBlob) => super.readAsArrayBuffer(jsdomBlob));
  }
}
assign('FileReader', BunBlobFileReader);
