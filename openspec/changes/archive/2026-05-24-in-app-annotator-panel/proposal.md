## Why

Today users have two disconnected ways to tell funny what to fix in a running UI: (a) describe it in prose inside a thread, which loses visual context, or (b) install the standalone Chrome extension, which forces a switch out of funny and creates threads with no connection to the panel from which they were launched. We need a way to point at a running URL, mark what's wrong visually, and turn that into a new thread — without leaving funny and without depending on a browser extension.

## What Changes

- Add a globe icon (🌐) to the global App header that toggles a new side panel.
- New side panel renders an `<iframe>` for a user-pasted URL plus a transparent React overlay (same-origin to funny) that captures input.
- Three annotation tools that work without DOM access to the iframe:
  - **Pin**: click drops a numbered marker with a note popover.
  - **Region**: drag draws a rectangle with a note popover.
  - **Draw**: free-hand canvas with a 5-color palette (red/amber/green/blue/white) reused from the Chrome extension's `DRAW_COLORS`.
- Ephemeral Zustand store for the panel's URL + annotation list. No DB persistence. Cleared on panel close or on send.
- "Send" action always **creates a new thread** with project/mode/model selection (like `NewThreadDialog`). The thread's first message is structured markdown listing the annotated URL and, per annotation: type, coords, user note, and a `data:` URL for the draw layer if non-empty.

Explicit non-goals (V1): auto-detect of dev server ports, cross-origin script injection, inspect/test-id/screenshot tools (the V2 tools that need iframe DOM access), annotation persistence, editing annotations after send, follow-up to an existing thread, changes to the Chrome extension.

## Capabilities

### New Capabilities

- `in-app-annotator`: Side panel that loads an arbitrary URL in an iframe, lets the user pin/region/draw annotations over it, and converts those annotations into a new funny thread.

### Modified Capabilities

<!-- None — no existing specs to modify. -->

## Impact

- **New files** in `packages/client/src/`:
  - `components/browser-panel/` directory: `BrowserPanel.tsx`, `BrowserUrlBar.tsx`, `BrowserOverlay.tsx`, `tools/PinTool.tsx`, `tools/RegionTool.tsx`, `tools/DrawTool.tsx`, `AnnotationList.tsx`, `SendDialog.tsx`.
  - `stores/browser-panel-store.ts` (Zustand, ephemeral).
  - `lib/browser-panel-markdown.ts` (annotation → markdown serializer).
- **Modified files**:
  - The global App header component (likely `App.tsx` or its header sub-component) gains the new icon and panel mount.
  - `stores/ui-store.ts` may gain a `browserPanelOpen` flag if cross-cutting visibility is needed; otherwise the panel store owns its own open/closed state.
- **No changes** to `server`, `runtime`, `core`, `shared`, or the `chrome-extension` package. Thread creation reuses the existing `POST /api/threads` endpoint via the existing client API layer.
- **New shadcn components** required (install if missing): none expected — Button, Input, Popover, ScrollArea, Tooltip, Dialog, Select are already installed per CLAUDE.md.
- **Telemetry**: new logger namespace `browser-panel` and metrics `browser_panel.opened`, `browser_panel.annotation_added` (with `type` attribute), `browser_panel.sent` (with `annotation_count`).
