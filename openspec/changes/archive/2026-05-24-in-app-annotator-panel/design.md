## Context

The Chrome extension at `packages/chrome-extension/` exists to solve "I see something broken in a running UI and want to tell the agent to fix it." It works on any webpage by injecting a Shadow DOM overlay, but it has two ergonomic costs: (1) the user has to leave funny and switch to Chrome, and (2) the extension creates threads with no awareness of the project context the user was working in.

This change brings the same loop inside funny as a **panel**: a globe icon in the sidebar's header toggles a side panel containing a URL bar, an `<iframe>` for any URL the user pastes, an overlay layer for visual annotation, and a "send" action that creates a new thread.

The panel must work **without** the cross-origin tricks the extension uses (Shadow DOM injection inside the target page). We accept the V1 limitation that we cannot read the iframe's DOM — Pin/Region/Draw all work purely from coordinates in the parent's overlay.

Related code already present in the repo:

- `packages/client/src/components/sidebar/SidebarTopBar.tsx` — the icon row where the new globe button mounts.
- `packages/client/src/components/PreviewBrowser.tsx` — separate Tauri preview-window component; **not** what we're modifying.
- `packages/chrome-extension/src/content.ts` — source of the `DRAW_COLORS` palette and the general pin/region/draw UX language.
- `packages/client/src/lib/api/threads.ts:64` — `threadsApi.createThread({ projectId, title, mode, model, prompt, ... })` is the integration point.

## Goals / Non-Goals

**Goals:**

- One-click access from anywhere in funny to "open a URL and mark what's wrong."
- Zero coupling to the URL's origin: works against any URL the user can reach from their browser, with no setup on the dev-server side.
- Annotations are visible immediately and accumulate until sent.
- Send produces a single new thread whose first user message contains enough structured detail (URL + per-annotation type/coords/note + draw image if any) that the agent has the context the extension would have given it.
- Stay inside `packages/client`. No server, runtime, core, or shared changes.

**Non-Goals:**

- Auto-detect dev server URLs from the project. The user pastes a URL.
- Read or modify the iframe's DOM. No selectors, no testid labels, no element outerHTML, no screenshots of the iframe contents. Those are V2.
- Persist annotations across reloads or panel close.
- Follow-up to an existing thread. Always a new thread.
- Touch the Chrome extension package. The two features can coexist.

## Decisions

### 1. Mount point: globe icon in `SidebarTopBar`, not a new app-level header

**Decision**: Add the globe `Button` next to the existing icon-row in `packages/client/src/components/sidebar/SidebarTopBar.tsx` (Search / Kanban / Grid / Analytics / Collapse).

**Why**: funny doesn't have a global top-of-app header. The sidebar header is the de facto location for app-level icon shortcuts — same row already hosts Search, Kanban, Grid, Analytics. Adding a sixth icon there is the lowest-friction integration that matches existing patterns.

**Alternatives considered**:

- New top app-bar across the whole window — invasive, would require restructuring `App.tsx` layout.
- Inside `ProjectHeader` (per-thread) — wrong scope; the panel is global.
- Floating action button — non-discoverable, breaks pattern.

### 2. Panel mounts at the app shell level, sibling to `SidebarInset`

**Decision**: The `BrowserPanel` is rendered inside `App.tsx` (or its layout child) as a flex sibling that takes width when open and width:0 when closed. Visibility state lives in the panel's own Zustand store (`useBrowserPanelStore`), not in `ui-store.ts`.

**Why**: Side panels in funny (e.g., `ReviewPane`, `TerminalPanel`, `ActivityPane`) are mounted at the App shell as siblings of the main content area. The panel needs to occupy a column independent of the active thread, so it cannot live inside `ThreadView`. Keeping `open/closed` in a dedicated store avoids polluting `ui-store.ts` with feature state.

**Alternatives considered**:

- shadcn `Sheet` — overlays content, dismisses on backdrop click; we want a persistent column, not a transient overlay.
- New `/browser` route — wastes the active thread; user can't reference what they're looking at while writing the description.

### 3. Overlay = transparent React layer in the parent, iframe gets `pointer-events: none`

**Decision**: The iframe and the overlay are siblings inside a `position: relative` container. The iframe has `pointer-events: none`; the overlay has `pointer-events: auto` and captures all mouse input for the active tool.

**Why**: This is the only way to capture mouse coordinates on top of a cross-origin iframe without injecting into it. The user loses the ability to _click through_ to the iframe while a tool is active — that's an acceptable trade because tool selection is explicit (none = "browse" mode where iframe gets `pointer-events: auto` again).

**Alternatives considered**:

- Allow click-through to the iframe and capture via `mousemove` listeners on `window` — fails because cross-origin iframes don't propagate mouse events to the parent.
- Cross-origin script injection (proxy or postMessage bridge) — explicit non-goal for V1; revisits in V2.

### 4. Annotation state shape

**Decision**: One discriminated union in `browser-panel-store.ts`:

```ts
type Annotation =
  | { id: string; kind: 'pin'; x: number; y: number; note: string }
  | { id: string; kind: 'region'; x: number; y: number; w: number; h: number; note: string }
  | { id: string; kind: 'draw'; dataUrl: string; color: string; note: string };
```

`x`/`y`/`w`/`h` are in **overlay-relative pixels at the time of creation** (no viewport-relative coords, no normalization to iframe size — we don't know the iframe size cross-origin). The store also holds `url: string`, `tool: 'none' | 'pin' | 'region' | 'draw'`, `drawColor: string`, and `open: boolean`.

**Why**: Coords are only meaningful to the human reading the markdown later (and the agent reading the screenshot if we ever add one). Keeping them in overlay-pixels is honest about what we can measure.

### 5. Send = `threadsApi.createThread` with structured markdown prompt + optional images

**Decision**: On Send, the panel calls `threadsApi.createThread({ projectId, mode, model, title, prompt, images? })` where:

- `title` = `Annotated: <URL>` (truncated to 80 chars).
- `prompt` = markdown produced by `lib/browser-panel-markdown.ts`:
  ```
  # Annotated URL: <url>

  ## Annotation 1 — pin @ (123, 456)
  <user note>

  ## Annotation 2 — region @ (x, y, w, h)
  <user note>

  ## Annotation 3 — draw (red)
  <user note>

  (see attached image)
  ```
- `images` = one `ImageAttachment` per non-empty `draw` annotation, derived from its canvas `dataUrl`.

**Why**: Reuses the existing thread-creation path (zero server changes). Markdown-in-prompt is how the rest of funny passes structured context to agents. Images travel as attachments per the existing `ImageAttachment` shape.

**Alternatives considered**:

- New `/api/annotations` endpoint that converts → thread server-side. Adds surface for no benefit; the client already has all the context.
- Embed `data:` URLs inline in the markdown. Bloats the prompt and bypasses the image-attachment pipeline.

### 6. Project / mode / model selection: reuse `NewThreadDialog`'s field components

**Decision**: The send confirmation step is a shadcn `Dialog` that imports the same project/mode/model `Select` controls used in `NewThreadDialog`. Defaults: last-used project (from `ui-store.ts` if available, else first project), `mode = 'local'`, `model = sonnet`.

**Why**: One source of truth for the field semantics. If `NewThreadDialog` changes its model list, the panel updates automatically.

### 7. Telemetry namespace and metrics

**Decision**:

- Logger: `createClientLogger('browser-panel')`.
- Metrics:
  - `browser_panel.opened` (counter) — every panel open.
  - `browser_panel.url_loaded` (counter, attr `protocol`) — successful URL load attempt.
  - `browser_panel.annotation_added` (counter, attr `kind`) — every annotation created.
  - `browser_panel.sent` (counter, attr `annotation_count`) — every successful send.
- Span: `browser_panel.create_thread` wrapping the `createThread` call.

**Why**: Per `packages/client/CLAUDE.md`, high-frequency observability lives in metrics, milestones in `info` logs, and async chains in spans. Send is a milestone _and_ a span (so we can correlate failures to user actions).

## Risks / Trade-offs

- **Iframe X-Frame-Options / CSP blocks rendering** → The URL bar surfaces `iframe.onerror` / `onload` timeouts and shows a `<TooltipContent>` "This site refuses to be embedded. Try a local dev server URL." Cannot be worked around without server changes; document the limitation.
- **Pointer-events:none breaks "let me click inside the page first to navigate"** → Add an explicit `tool === 'none'` (Browse) mode where the iframe regains `pointer-events: auto`. The toolbar shows the Browse mode as a tool option (cursor icon), and the panel defaults to Browse on open.
- **Cross-origin iframe resize → annotation coords drift visually** → Acceptable for V1; document that annotations are pinned to the overlay viewport at creation time. If the user resizes the panel, pins/regions visually drift but their stored coords don't change. Mitigation in V2: store ratios to overlay size and re-project on resize.
- **Large draw canvases bloat the request** → Cap the draw canvas resolution at the overlay's device-pixel size (no upscaling), and JPEG-encode at quality 0.85 when serializing to `dataUrl`. If the resulting payload exceeds ~2 MB, log a warning and proceed; the existing `createThread` accepts images via the standard upload path.
- **Globe icon doesn't fit in `SidebarTopBar`'s hover-revealed row when the sidebar is collapsed** → The collapsed-sidebar strip (`CollapsedSidebarStrip` in `App.tsx`) is a single PanelLeft icon; do not add the globe there in V1. Document that the panel is reachable only with the sidebar expanded. Optional V2: add it to the collapsed strip with a keyboard shortcut.
- **Multiple panels open at once (Review + Terminal + Browser) on small screens** → Existing panels already compete for horizontal space. The browser panel honors the same `ResizeHandle` pattern (`packages/client/src/components/ui/resize-handle.tsx`) with a minimum width of 320px, and its width persists to localStorage under `browser_panel_width`.

## Migration Plan

No data migration. Feature is additive and gated only by the user clicking the new icon. Rollback = revert the commit; no state to clean up because the store is ephemeral and the icon is non-destructive.

## Open Questions

- Should the panel remember the last-used URL across sessions (localStorage only, no DB)? Lean **yes**, low cost, but defer until tasks if it complicates the ephemeral store contract.
- Should `Browse` mode (pointer-events on the iframe) be an explicit tool icon, or the default state with no tool selected? Lean **explicit tool** for discoverability — show a `MousePointer` icon as the first tool, selected by default on open.
