## Why

The current in-app annotator panel embeds the target URL via `<iframe>`. That model has three hard limits:

1. **Cross-origin sandbox.** No DOM access from the panel, so the missing 7 icons from the Chrome extension (test-id overlay, screenshot, inspect, hover labels, multi-select, pause animations, framework detection) cannot be implemented. The previous design.md explicitly listed these as V2 non-goals for this reason.
2. **X-Frame-Options / CSP `frame-ancestors`.** Most public sites (Google, Twitter, most news/auth flows) refuse embed entirely. Only sites the user controls (their own dev servers) work reliably.
3. **Tainted canvas.** No way to capture screenshots of the rendered page beyond the user's own free-hand draw layer.

The repo already has the building blocks to replace the iframe with a server-driven Chromium streamed as JPEG frames over WebSocket:

- `ChromeSession` in [`packages/core/src/chrome/chrome-session.ts`](../../../../packages/core/src/chrome/chrome-session.ts) — CDP wrapper with navigate / screenshot / execute / mouse / keyboard / scroll / console / network / error events.
- `playwright` already a dependency of `@funny/runtime` (the chromium binary ships with it).
- `BrowserPreview.tsx` in test-runner uses the same JPEG-frames-on-canvas pattern we need.
- `wsBroker` already streams frames from `ChromeSession` to clients (see `test-runner.ts:720-790`).

This change re-engineers the annotator viewport to spawn a per-session Chromium on the user's runner, stream frames to the panel, and forward input/inspect requests via CDP. The result is feature parity with the Chrome extension _plus_ the ability to open any URL.

## What Changes

- Replace `<iframe>` in `BrowserViewport.tsx` with a `<canvas>` driven by JPEG frames streamed from the runner.
- Add a new `BrowserSessionManager` service in `packages/runtime/src/services/` that:
  - Spawns Chromium (via Playwright's `chromium.executablePath()`) with `--remote-debugging-port=<dynamic>`.
  - Wraps each instance in `ChromeSession` (reused as-is).
  - Maintains a one-Chrome-per-active-panel pool, scoped to the user's runner.
- Extend the runner↔server runner-protocol with `browser-session:*` message types (open, navigate, input, inspect-at, screenshot, close) and frame events.
- Pin / region tools now resolve clicks to actual DOM elements via CDP `Runtime.evaluate(document.elementFromPoint(x,y))`, capturing `selector`, `testid`, computed styles, accessibility info, and a per-element screenshot. Annotations carry rich element metadata in addition to coordinates.
- New tool buttons become functional: `show-testids`, `copy-screenshot`, `pause-animations`, `inspect-mode` (hover labels). The 5 grayed-out toolbar icons from the previous V1 batch are wired up.
- Remove the "site refuses to be embedded" code path (no longer reachable — Chromium loads anything the user's runner can reach).

## Capabilities

### Modified Capabilities

- `in-app-annotator` — Viewport model changes from iframe-overlay to CDP-stream-on-canvas. Annotation data shape gains a `dom: { selector, testid, computedStyles, screenshot, ... }` field on pin / region annotations. Tool inventory expands by 4 (testids overlay, screenshot, pause animations, inspect mode).

### New Capabilities

<!-- None — this is a re-engineering of an existing capability, not a new one. -->

## Impact

- **New files** in `packages/runtime/src/`:
  - `services/browser-session-manager.ts` (~250 lines) — Chrome lifecycle + per-session state.
  - `routes/browser-session.ts` — HTTP + WS routes mounted under `/api/browser-session/*` and `/ws/browser-session/:id`.
- **Modified files**:
  - `packages/shared/src/runner-protocol.ts` — new `browser-session:*` message types.
  - `packages/client/src/components/browser-panel/BrowserViewport.tsx` — iframe → canvas.
  - `packages/client/src/components/browser-panel/tools/{PinTool,RegionTool,DrawTool}.tsx` — input goes through WS, pin/region annotations carry DOM metadata.
  - `packages/client/src/stores/browser-panel-store.ts` — adds `sessionId`, `sessionStatus`, enriched `Annotation` types.
  - `packages/client/src/components/browser-panel/ToolToolbar.tsx` — wire up the 4 newly-possible icons.
- **No changes** to `packages/server` route logic — the existing runner WS tunnel proxies all `browser-session:*` messages.
- **Runner footprint**: ~150 MB extra per active panel session (Chromium process). Chrome binary ships with Playwright dep, no extra install. Port pool dimension grows by N concurrent panels.
- **Telemetry**: new metrics `browser_session.opened`, `browser_session.closed`, `browser_session.frame_dropped`, span `browser_session.inspect` wrapping CDP `Runtime.evaluate`.
- **Backwards compat**: annotations created under the old iframe model only have `(x, y)` — markdown serializer must keep handling them. The legacy path is preserved; only newly-created annotations get the enriched shape.
