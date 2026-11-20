## 1. Store and types

- [x] 1.1 Create `packages/client/src/stores/browser-panel-store.ts` with the `Annotation` discriminated union (`pin | region | draw`) and the store shape: `{ open, url, loadedUrl, tool, drawColor, annotations, ...actions }`.
- [x] 1.2 Implement actions: `togglePanel`, `closePanel`, `setUrl`, `submitUrl`, `setTool`, `setDrawColor`, `addAnnotation`, `updateAnnotationNote`, `removeAnnotation`, `setDrawCanvasRef`, `clearDraw`, `reset`.
- [x] 1.3 Wire `createClientLogger('browser-panel')` and the four metrics defined in design §7 (`browser_panel.opened`, `url_loaded`, `annotation_added`, `sent`).
- [x] 1.4 Add `funny:log-ns:browser-panel` to the runtime toggle docs comment at the top of the store file.

## 2. Markdown serializer

- [x] 2.1 Create `packages/client/src/lib/browser-panel-markdown.ts` exporting `annotationsToMarkdown(url, annotations)` that returns the structured markdown specified in design §5.
- [x] 2.2 Create `extractImageAttachments(annotations)` that returns one `ImageAttachment` per non-empty draw annotation (PNG `dataUrl` → base64 → matches the `ImageAttachment` shape from `@funny/shared`).
- [x] 2.3 Add unit test `packages/client/src/lib/browser-panel-markdown.test.ts` covering: pin-only, region-only, draw-only, mixed, empty-note pin (note section omitted), URL truncation in title.

## 3. Globe icon entry point

- [x] 3.1 In `packages/client/src/components/sidebar/SidebarTopBar.tsx`, add a `<Tooltip>` + icon `<Button>` using `Globe` from `lucide-react`, positioned between Analytics and the collapse button.
- [x] 3.2 Wire onClick to `useBrowserPanelStore.getState().togglePanel`.
- [x] 3.3 Add `data-testid="sidebar-browser-panel"` and `t('sidebar.browser_panel', 'Browser annotator')` translation key in `packages/client/src/locales/en/translation.json` (and any other locales used in the repo — match the keys present for `sidebar.search`).

## 4. Panel shell layout

- [x] 4.1 Create `packages/client/src/components/browser-panel/BrowserPanel.tsx` that subscribes to `useBrowserPanelStore` and returns `null` when `open === false`.
- [x] 4.2 Render a flex-column container with: `BrowserUrlBar` → toolbar → `BrowserViewport` (iframe + overlay) → `AnnotationList` → footer with Send button.
- [x] 4.3 Mount `BrowserPanel` inside `packages/client/src/App.tsx` as a sibling of `SidebarInset` so it shares the main layout row. Use `ResizeHandle` with `localStorage` key `browser_panel_width`, default 480, min 320.
- [x] 4.4 Add a `lazy()` import so the panel chunks separately (match the existing `lazy(...)` pattern in `App.tsx`).

## 5. URL bar

- [x] 5.1 Create `BrowserUrlBar.tsx` with a shadcn `Input` (`data-testid="browser-panel-url-input"`) and a `Button` (`data-testid="browser-panel-url-go"`).
- [x] 5.2 On submit: if input lacks a scheme, prepend `http://`; call `submitUrl(normalized)`; emit `browser_panel.url_loaded` metric with `protocol` attribute.
- [x] 5.3 Render an inline error when `iframe.onerror` fires or `onload` does not fire within 5s — show "This site refuses to be embedded. Try a local dev server URL." (detection logic in BrowserViewport — task 6 — writes to store.loadError; URL bar renders it)

## 6. Viewport (iframe + overlay)

- [x] 6.1 Create `BrowserViewport.tsx`: a `relative` container with `<iframe src={loadedUrl}>` and a sibling overlay `<div>`.
- [x] 6.2 Drive `pointer-events` on both via the active tool: Browse → iframe auto, overlay none; any other tool → iframe none, overlay auto.
- [x] 6.3 Forward all relevant mouse handlers from the overlay to the active tool component.

## 7. Pin tool

- [x] 7.1 Create `browser-panel/tools/PinTool.tsx` that renders existing pin annotations as numbered circles at their stored `(x, y)` and handles `onClick` to add a new pin via `addAnnotation({ kind: 'pin', x, y, note: '' })`.
- [x] 7.2 On pin creation, open a shadcn `Popover` anchored at the click coords with a `Textarea` for the note; on Save (button or Cmd+Enter) call `updateAnnotationNote(id, text)` and close popover.
- [x] 7.3 Click on an existing pin number reopens its note popover.

## 8. Region tool

- [x] 8.1 Create `browser-panel/tools/RegionTool.tsx`. Track `dragStart` / `dragCurrent` in component state; on `mousedown` start, `mousemove` update, `mouseup` commit.
- [x] 8.2 On commit, normalize negative-direction drags (positive `w`, `h`), call `addAnnotation({ kind: 'region', x, y, w, h, note: '' })`, then open the note popover.
- [x] 8.3 Render the live drag rectangle and all committed region rectangles as absolutely-positioned divs with a dashed border.

## 9. Draw tool

- [x] 9.1 Create `browser-panel/tools/DrawTool.tsx`. Render a `<canvas>` sized via `ResizeObserver` to match the overlay (with `devicePixelRatio` scaling).
- [x] 9.2 Implement pointerdown/move/up stroke handling using `drawColor`; lineWidth 3px, round caps.
- [x] 9.3 Render the color palette (5 swatches matching the `DRAW_COLORS` constant from the chrome extension) plus a Clear button and a single shared `Textarea` for the draw annotation's note.
- [x] 9.4 On first stroke, ensure exactly one `{ kind: 'draw', dataUrl: '', color, note: '' }` entry exists in the store; on Clear, remove it; on send, lazily serialize `canvas.toDataURL('image/png')` into the entry.

## 10. Annotation list

- [x] 10.1 Create `AnnotationList.tsx` rendering each annotation in a shadcn `ScrollArea` with: 1-based number badge, kind icon, coord summary (`(x, y)` or `(x, y, w×h)` or "drawing"), note snippet (first 60 chars), and a remove `Button` (`data-testid="browser-panel-annotation-remove-<id>"`).
- [x] 10.2 Remove button calls `removeAnnotation(id)`; the list re-renders with renumbered badges.

## 11. Send flow

- [x] 11.1 Create `SendDialog.tsx` using shadcn `Dialog`. Selectors: project (from `useProjectStore`), mode (`local` only for v1 — disable other options since this isn't a worktree flow), model (sonnet/opus/haiku) — extract the existing options used by `NewThreadDialog` into a shared module if straightforward, else duplicate for v1 and add a `// TODO: dedupe with NewThreadDialog` note.
- [x] 11.2 Default project = last-used (read `useUIStore` if a key exists for it; else first project). Defaults: `mode='local'`, `model='sonnet'`.
- [x] 11.3 Confirm button is disabled when there are zero projects; show "Create a project first" in that case.
- [x] 11.4 On Confirm: build `prompt` via `annotationsToMarkdown`, `images` via `extractImageAttachments`, call `threadsApi.createThread(...)` wrapped in `startSpan('browser_panel.create_thread')`.
- [x] 11.5 On success: emit `browser_panel.sent` counter with `annotation_count` attr, call `store.reset()`, navigate to `/threads/:newId` via `useStableNavigate`, close panel.
- [x] 11.6 On failure: log `error`-level with the err, show a `toast.error` via `@/components/ui/sonner`, keep panel and dialog open.
- [x] 11.7 Disable Send button in the panel footer when `!loadedUrl || annotations.length === 0`.

## 12. Theming and font size

- [x] 12.1 Audit all new files for hardcoded hex colors outside `DRAW_COLORS`; replace with theme variables (`bg-card`, `text-foreground`, `border-border`, etc.).
- [x] 12.2 Wrap text in `BrowserUrlBar`, `AnnotationList`, and popover textareas with the font-size hooks from `@/stores/settings-store` so they react to setting changes.

## 13. Tests

- [x] 13.1 Add `e2e/browser-panel.spec.ts` covering: open/close panel, paste localhost URL, switch to Pin tool, click to add pin, type note, click Send → confirm dialog → mock createThread → assert thread navigation.
- [x] 13.2 Add a second e2e flow: Draw tool + color change + Clear button + Send with image attachment present.
- [x] 13.3 Add a third e2e flow: Region drag in reverse direction normalizes coords correctly.
- [x] 13.4 Ensure `extractImageAttachments` and `annotationsToMarkdown` unit tests from §2.3 pass.

## 14. Verification

- [x] 14.1 Run `bun run build` from repo root; confirm no type errors in `packages/client`. (Build succeeded; all chunks emitted; only pre-existing large-chunk warnings.)
- [x] 14.2 Run `bunx tsc --noEmit` and resolve any remaining type issues. (Clean — no errors. 897 unit tests pass, 0 failed.)
- [x] 14.3 Manual verification confirmed by user — panel opens, tools work, send creates threads visible in the sidebar.
- [x] 14.4 Telemetry verification confirmed by user.
- [x] 14.5 Verify the chrome-extension package is untouched (`git diff packages/chrome-extension` returns nothing). (Confirmed — empty diff.)
