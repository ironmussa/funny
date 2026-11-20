## Context

The V1 panel ([in-app-annotator-panel](../2026-05-24-in-app-annotator-panel/)) embedded URLs via cross-origin `<iframe>`. The Chrome extension at `packages/chrome-extension/` has 7 features the V1 panel can't replicate (test-id labels, screenshot, inspect, hover labels, multi-select, pause animations, framework detection) — all of them require DOM access to the embedded page, which a cross-origin iframe cannot give.

The user's runner (`packages/runtime`) already runs untrusted code in the user's environment (Claude CLI spawn, PTY shells, native git ops) — adding a Chromium subprocess is consistent with that trust boundary. The runtime already imports `playwright` and has `ChromeSession` for streaming frames from a CDP-enabled Chrome. The test-runner feature streams frames the exact way this panel needs.

## Goals / Non-Goals

**Goals:**

- Replace the iframe viewport with a CDP-streamed canvas so any URL loads, regardless of `X-Frame-Options`.
- Enable test-id overlay, full-viewport screenshot, inspect mode, hover labels, pause animations — closing the parity gap with the Chrome extension.
- Pin / region annotations carry the DOM element data the agent needs to locate code (selector, testid, classes, computed styles, accessibility info).
- Reuse `ChromeSession`, `wsBroker`, `allocatePort`, and the BrowserPreview canvas pattern wholesale — minimize new code.
- One Chromium per active panel session, scoped to the user's runner (no shared infrastructure).

**Non-Goals:**

- Persistent login state across sessions (`storageState` save/restore) — defer to V3 once the basic flow works.
- Network capture UI / console capture UI in the panel — `ChromeSession` emits these events but surfacing them in the annotator UI is V3.
- Browser pool / hot standby — V1 spawns Chrome on `open`, kills on `close`. Cold-start latency (~1.5-2 s) is acceptable.
- Multi-page tab UI inside the panel. One URL, one tab per session.
- Mobile / device emulation — desktop viewport 1280×720 only.

## Decisions

### 1. Spawn Chromium directly, not via `playwright test`

**Decision:** `BrowserSessionManager` spawns `chromium.executablePath()` as a child process with the standard headless flags + `--remote-debugging-port=<allocated>`. We do NOT invoke `playwright` the test runner.

**Why:** The test-runner pattern injects `--remote-debugging-port` into the user's `playwright.config.ts` and runs a real test suite. Here we want a long-running browser with no test attached. Spawning the binary directly:

- Avoids dragging in `@playwright/test`, reporters, config wrappers.
- Lifecycle is plain `child_process.spawn` + `kill` — no test process to coordinate with.
- Lets us bypass the user's project entirely. The panel is a global tool, not a per-project one.

**Alternatives considered:**

- `playwright.chromium.launch({ args: ['--remote-debugging-port=N'] })` — pulls in the entire Playwright runtime (~50 MB extra), and Playwright takes the browser-level CDP slot. We'd still need `ChromeSession` on the page slot, so we'd pay for two CDP clients instead of one. The only thing we'd gain is convenient `BrowserContext` isolation, which we don't need for V1 (one Chrome = one context).

### 2. One Chromium per panel session, port-allocated

**Decision:** `BrowserSessionManager` allocates a port via `@funny/core/ports` for each new session and spawns a dedicated `chromium` instance bound to that port. Up to N concurrent sessions per runner, where N is bounded by available ports (and indirectly by RAM).

**Why:**

- Clean isolation: cookies, storage, viewport state all scoped to one Chrome.
- Trivial cleanup: `proc.kill()` on session close. No risk of leaked tabs.
- Aligns with the runner-isolation invariant (each user's data lives in their own runner).
- The test-runner's fixed-port (9223) approach doesn't generalize to multi-session.

**Trade-off:** ~150 MB RAM per active panel. Acceptable for the assumed 1-2 concurrent panels per user. Document the limit in CLAUDE.md.

**Alternatives considered:**

- Single shared Chromium, multiple `BrowserContext`s — saves ~30% RAM but requires `playwright.chromium.launch()` (see Decision 1), and routing CDP events to the right session adds complexity. Revisit if memory becomes a real problem.
- Container-per-session — overkill for v1; the test-runner already lives without containers.

### 3. Frame streaming reuses the test-runner WebSocket pattern

**Decision:** `BrowserSessionManager` subscribes to `ChromeSession`'s `frame` event and broadcasts via `wsBroker.emitToUser(userId, { type: 'browser-session:frame', sessionId, data })`. The client renders into a `<canvas>` using the same pattern as `BrowserPreview.useBrowserFrameRenderer`.

**Why:** Already proven to work at 30 fps over the runner WS tunnel. JPEG quality 60 at 1280×720 averages ~500 KB/s — fine for LAN runners, acceptable for remote runners.

**Frame ack handling:** `ChromeSession.connect()` already auto-acks frames internally; nothing to add.

**No streaming optimizations in v1:** No webrtc, no h264 — JPEG via CDP `Page.screencastFrame` is good enough until proven otherwise.

### 4. Input is fire-and-forget, inspect is request/response

**Decision:** Two distinct message styles:

- **Input messages** (mouse move, click, scroll, key) are fire-and-forget. Client → `dispatchMouseEvent` / `dispatchKeyEvent` on the runner. No ack. The next frame the user sees IS the ack.
- **Inspect messages** (`browser-session:inspect-at`) are request/response with a `requestId`. The runner runs `Runtime.evaluate(document.elementFromPoint(x,y).{tag, id, classes, testid, ...})`, returns the result via `browser-session:inspect-result { requestId, element }`.

**Why:** Frame streaming provides natural feedback for input. Wrapping every click in a roundtrip ack would double the latency budget for no UX gain. Inspect is genuinely a "give me this data" call so it needs request/response.

### 5. Pin / region annotation shape is extended, not replaced

**Decision:** Existing `Annotation` discriminated union gains an optional `dom` field on `pin` and `region` variants:

```ts
type PinAnnotation = {
  id: string;
  kind: 'pin';
  x: number;
  y: number;
  note: string;
  dom?: {
    selector: string; // best-effort CSS selector
    testid?: string;
    tagName: string;
    text?: string; // first 80 chars
    classes: string[];
    componentName?: string; // React Fiber / Vue / Svelte if detected
    boundingBox: { x: number; y: number; w: number; h: number };
    computedStyles: Record<string, string>; // subset: color, bg, font, display, position
    accessibility: { role?: string; ariaLabel?: string; tabIndex?: number };
  };
};
```

`dom` is **optional** because (a) annotations from the legacy iframe path don't have it, (b) `elementFromPoint` can return null over empty regions, (c) some click targets (Shadow DOM) may not yield a stable selector.

`extractImageAttachments` and `annotationsToMarkdown` are updated to include `dom` data when present. Backwards-compatible — pre-existing markdown tests stay green.

### 6. Browser session lifecycle is owned by the panel

**Decision:**

- `togglePanel(true)` → client calls `POST /api/browser-session/:userSessionId` with the initial URL → runner spawns Chromium + connects ChromeSession → returns `{ sessionId }`.
- `togglePanel(false)` → client calls `DELETE /api/browser-session/:sessionId` → runner kills Chromium + frees port.
- A heartbeat every 30 s from client → runner. After 2 missed beats (90 s), runner force-closes the session and frees resources.
- On runner restart, all sessions are lost (state is in memory). Client detects via `browser-session:disconnect` and shows a "Reconnect" affordance.

**Why:** Mirrors the existing thread lifecycle pattern. Heartbeat is necessary because the user can close the panel by closing the browser tab — there's no clean unmount signal.

### 7. Telemetry

- `browser_session.opened` counter (attr: `runner_id`)
- `browser_session.closed` counter (attr: `reason ∈ { user, heartbeat, error, runner_shutdown }`)
- `browser_session.frame_dropped` counter — frames the WS broker couldn't deliver
- `browser_session.inspect` span — wraps each CDP `Runtime.evaluate` call so we can correlate slow inspect calls with page load state

Logger namespace: `browser-session`. Runtime toggle: `__funnyLog.setNamespaceLevel('browser-session', 'debug')`.

## Risks / Trade-offs

- **Cold-start latency.** Chromium boot + CDP connect takes 1.5-2 s. Mitigation: show a spinner with text "Spawning Chrome…" during boot. Don't pre-warm a pool in v1.
- **Bandwidth.** JPEG q60 at 1280×720 = ~500 KB/s sustained. Acceptable for local + LAN; high for remote runners. v2 can drop quality on idle.
- **Memory pressure.** 150 MB per active session × N concurrent panels per runner. With N=2 this is fine; N=10 starts hurting. Hard cap at N=4 with toast "Close another browser panel first" — refined by usage data.
- **Shadow DOM / web components.** CSS selectors don't cross shadow roots. The `dom.selector` field will be best-effort and may not match for elements inside closed shadow trees. Markdown still gets the rendered `text` and `screenshot` so the agent has SOMETHING to work with.
- **Cookies / auth.** V1 sessions start cookie-less. Sites requiring login (most SaaS dashboards) show a sign-in wall in the panel. The user must complete sign-in inside the panel (via clicks streamed to Chrome) — this works, but feels weird. V3 will support persistent `storageState`.
- **Sandbox flag.** Chromium spawns with `--no-sandbox` because runners often run in containers without user namespaces. The runner already trusts the user, so this doesn't expand the trust boundary, but document it in CLAUDE.md.
- **Headless detection.** Some sites (Cloudflare, Akamai bot challenges) block headless Chrome. Acceptable — those sites also fail in Playwright tests today; this is a known industry issue, not unique to us.

## Migration Plan

This change does NOT touch any data model — `Annotation` gains an optional field, that's it.

Rollout:

1. Ship the runtime service + WS messages behind a feature flag (`BROWSER_PANEL_CDP=1` env var).
2. When flag off: client falls back to the iframe path. Existing users see no change.
3. When flag on: client uses CDP path. Annotations get `dom` data.
4. After two weeks of soak, remove the flag and the iframe code path.

Rollback = drop the feature flag. No data migration needed.

## Open Questions

- **Should the panel let the user use the real Chrome devtools inside the streamed Chrome?** CDP supports `Page.bringToFront()` → user could `F12` and DevTools would open in the streamed window. Useful for debugging but bigger UX change. Defer.
- **Should pin clicks "freeze" the page** (pause animations + JS) so the captured element data is stable? Right now a click triggers any normal handlers on the page (forms submit, modals open). Mitigation idea: send `dispatchMouseEvent` only when the active tool is `browse` — when pin/region tools are active, intercept and only inspect without dispatching the real click. **Lean: yes, this is the right v1 behavior**. Detailed in tasks.md.
