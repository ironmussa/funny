# Browser Panel — Screenshot (iframe mode)

**Status:** Deferred. Button is currently disabled in iframe mode (`VITE_BROWSER_PANEL_CDP=0`).

## Why it's disabled today

Screenshot in [ToolToolbar.tsx](../packages/client/src/components/browser-panel/ToolToolbar.tsx) calls `browserSessionClient.screenshot(sessionId)` which uses CDP `Page.captureScreenshot`. In iframe mode there is no CDP session, so the call has no backend.

`cdpReady = USE_CDP && sessionStatus === 'ready' && sessionId !== null` — when `USE_CDP` is `false`, the button stays disabled with tooltip "Requires browser session".

## Why we can't just `html2canvas` the iframe

The browser blocks reading pixels from a cross-origin `<iframe>` (tainted canvas). `html2canvas`, `canvas.drawImage`, and `getImageData` all fail. Only same-origin iframes can be captured this way — useless for screenshots of arbitrary URLs.

## Options to implement later

### Option 1 — `getDisplayMedia()` (client-only)

Prompt the user to share the current tab/window, grab one frame, copy as PNG.

- Pros: zero backend work, works cross-origin, no extra processes.
- Cons: prompts the user every time, captures the whole tab (not just the iframe), can't isolate the iframe rect cleanly.

Sketch:

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
const track = stream.getVideoTracks()[0];
const imageCapture = new ImageCapture(track);
const bitmap = await imageCapture.grabFrame();
track.stop();
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
const ctx = canvas.getContext('2d')!;
ctx.drawImage(bitmap, 0, 0);
const blob = await canvas.convertToBlob({ type: 'image/png' });
// then ClipboardItem write
```

### Option 2 — Runner-side Playwright on demand

Add a runtime route `POST /api/browser-screenshot { url, viewport }` that:

1. Spawns a short-lived Playwright `chromium.launch({ headless: true })`.
2. Loads the URL, waits for `networkidle` (or a fixed delay).
3. `page.screenshot({ type: 'png' })`, closes browser, returns base64.

Pros: works for any URL, no user prompt, server-rendered (consistent).
Cons: ~1–2s cold-start per shot, Chromium binary must be present (already required for CDP path), no live-state capture (renders a fresh navigation, not what the user sees in the iframe).

### Option 3 — Re-enable CDP mode just for screenshot

Keep iframe mode for navigation/interaction, but spin up a CDP session lazily when the user clicks the screenshot button. Tear it down after. Reuses existing `browser-session-manager.ts` code paths.

Pros: pixel-accurate to what the iframe shows (in theory), reuses tested code.
Cons: ~2–3s spawn latency, Chromium binary dependency, "what the user sees" diverges from "what the CDP browser renders" (cookies, login state, viewport sizing).

## Recommendation

Start with **Option 1** (`getDisplayMedia`) — it's a few lines of client code, no backend, works today for anyone with a modern browser. Promote to **Option 2** later if users complain about the prompt or want batched screenshots in automations.

## When picking this up

- Re-enable the button when `!USE_CDP` (drop the `cdpReady` gate or add a new `screenshotReady` predicate).
- Update tooltip copy to match the chosen mechanism.
- Test with cross-origin sites (google.com, github.com) and same-origin (localhost dev server).
