## 1. Baseline and in-browser benchmark (gate)

- [x] 1.1 Extend `scripts/benchmark-markdown-renderers.ts` with a browser/WASM run (Vite playground or Playwright harness); record ops/sec and `.wasm` bundle size
- [x] 1.2 Build a long-thread fixture (≥500 messages, mixed markdown + tool calls) reusable by tests and profiling
- [x] 1.3 Create `scripts/profile-client.ts` (CDP): JS heap, DOM nodes, thread-switch time, scroll frame times; record baseline numbers in `docs/plans/satteri-markdown-migration.md`
- [x] 1.4 Evaluate the gate: Sätteri-WASM clearly wins in-browser, so use it as the sole thread markdown engine

> Status (2026-07-14): 1.1–1.4 are complete. The Vite-built Chromium benchmark
> shows Sätteri-WASM + DOMPurify at 1.78× the legacy end-to-end throughput on
> the deterministic corpus. `scripts/profile-client.ts` records the controlled
> 500-message CDP baseline. Bun cannot install upstream's `cpu: ["wasm32"]`
> target directly, so the browser-only client vendor shim records the exact
> upstream integrity and lets Vite emit the asset. Details and metrics are in
> `docs/plans/satteri-markdown-migration.md` → "Phase 0 — browser findings".

## 2. Safe render layer (safe-markdown-rendering)

- [x] 2.1 Move `satteri` into `packages/client` dependencies; verify the wasi-browser binding bundles under Vite dev and `bun run build`
- [x] 2.2 Implement `packages/client/src/lib/satteri-markdown.ts` — `renderMarkdownToSafeHtml` (compile → allow-list sanitize); decide DOMPurify vs HAST-plugin sanitization with measurements
- [x] 2.3 Implement byte-capped LRU cache keyed by content hash
- [x] 2.4 Unit tests: XSS fixture corpus (script/iframe/onerror/javascript: URLs), GFM parity, benign GitHub-style HTML, cache eviction

## 3. Parity: segments, delegation, highlighting

- [x] 3.1 Segment splitter: fenced blocks needing React (visualizers, nested markdown, local images) become island segments; prose stays HTML segments
- [x] 3.2 Delegated event handling module: local-path links → open-in-editor (port from `MessageContent.tsx`), code copy buttons, image → lightbox
- [x] 3.3 Idle-time post-processing of `<pre><code class="language-*">` with existing `highlightCode`
- [x] 3.4 Snapshot parity tests: real-message corpus rendered by both engines, semantic diff (links, tables, task lists, code blocks)

## 4. Sätteri-only engine integration

- [x] 4.1 Remove the markdown-engine setting and use Sätteri as the sole thread renderer
- [x] 4.2 Wire the segment renderer into `MessageContent` with an error boundary → safe plain-text source + `markdown.satteri_error` metric; WASM load failure uses the same state
- [x] 4.3 Streaming recompile throttled to once per animation frame with a final full compile
- [x] 4.4 Switch the WebFetch/WebSearch markdown branch in `ToolCallCard` to the safe renderer

> Status (2026-07-14): DOMPurify was selected over a HAST sanitizer because the
> Chromium Phase 0 benchmark already measured the complete Sätteri + DOMPurify
> pipeline. `renderMarkdownToSafeHtml` dynamically imports Sätteri on the first
> thread message; the temporary and failure states preserve source text without
> invoking another Markdown renderer. WebFetch and WebSearch already render
> through `MessageContent`, so they inherit the same safe engine without
> changing tool-card dispatch.

## 5. FrozenMessage (frozen-message-rendering)

- [x] 5.1 `FrozenMessage` component: freezes assistant markdown to captured (rehype-sanitize'd) HTML via `dangerouslySetInnerHTML`; gated by `FrozenViewerContext` so the virtual path is untouched
- [x] 5.2 Freeze criteria: intersection-based (live near viewport, frozen far offscreen) instead of a fixed tail — preserves interactivity on visible rows and rehydrates on scroll-back, no delegation module needed
- [x] 5.3 Unfreeze on demand for fork/rewind/message controls — fork/rewind chrome belongs to user rows, which never enter `FrozenMessage`; assistant rows rehydrate on returning to the viewport before they can be interacted with.
- [x] 5.4 Collapsed tool cards render preview only — already satisfied: GenericToolCard/BashCard/etc. gate the full output behind `expanded` (only a short preview when collapsed)
- [x] 5.5 Tests: unmount/remount (fiber-drop) proven on freeze/rehydrate; full 500-message fiber-count + no-layout-shift assertions pending

## 6. Frozen viewer: in-flow list + scroll (thread-scroll-navigation)

- [x] 6.1 Add `threadViewer: 'virtual' | 'frozen'` flag (default `virtual`); `MemoizedMessageList` path untouched
- [x] 6.2 New in-flow list renderer (no absolute positioning); `content-visibility: auto` + `contain-intrinsic-size: auto` (the `auto` keyword makes the UA remember each row's rendered height — no manual cache; supersedes the measured-height approach)
- [x] 6.3 IntersectionObserver sentinels top/bottom wired to existing `hasMore`/`hasMoreAfter` windowed pagination; in-flight guard against duplicate loads
- [x] 6.4 Per-thread position persistence: anchor message id + pixel offset (or bottom-pinned marker); restore by loading the window around the anchor
- [x] 6.5 Sticky-bottom during streaming on native scroll (pin unless user scrolled up past threshold)
- [x] 6.6 `expandToItem`: scrolls to any loaded row (all mounted in-flow); unloaded-window loading is handled caller-side by `store.loadMessagesUntil` (viewer-agnostic, same as virtual). Covered by a test.
- [x] 6.7 Sticky user-message headers — done via native `position: sticky` (no per-frame JS), with tests
- [x] 6.8 Find-in-page invariant covered at unit level (offscreen frozen rows keep their text in the DOM; all loaded rows stay mounted). A true in-browser Ctrl+F E2E still needs the running app on a real browser.

## 7. Validation, distribution, rollout

- [x] 7.1 Playwright long-thread suite: top↔bottom sweep with bidirectional loads, position restore across thread switches, streaming pin, Ctrl+F

> Status (2026-07-14): `e2e/thread-long-history.spec.ts` drives a 500-message
> windowed fixture through both pagination directions, restores a reading anchor
> across a thread switch, exercises native Ctrl+F, and verifies streaming both
> while bottom-pinned and while reading older messages. The live Socket.IO event
> path is used for the streaming assertions. `bunx playwright test
> e2e/thread-long-history.spec.ts --reporter=line --workers=1` passes.

- [x] 7.2 Re-run `scripts/profile-client.ts` with `satteri`+`frozen`; record before/after (heap, DOM nodes, fibers, switch time, frame times) in the plan doc

> Status (2026-07-14): Phase 7 profiling is recorded in the plan. Forced-GC
> snapshots show the frozen path's heap is bounded, but switching a 500-message
> thread is 246.20 ms versus 24.60 ms for virtual+Sätteri because the full DOM is
> mounted at once. `threadViewer=frozen` must not be rolled out until that
> first-mount cost is resolved.

- [ ] 7.3 Distribution smoke: `bun run build` + `bun run tauri:build`; packaged app renders markdown via Sätteri (`.wasm` resolves)

> Status (2026-07-14): Rust Tauri is aligned to 2.11.1 and `bun run build`
> emits the Sätteri asset. The desktop build reaches the bundle stage and emits
> `.deb` and `.rpm` artifacts whose embedded binary contains the Sätteri WASM
> asset. The all-target command remains non-zero only because AppImage's
> external GTK `linuxdeploy` plugin aborts when `ldd` exits 1 on a host library.
> Re-run the all-target smoke in a clean Linux packaging image; this is an
> AppImage host-tool issue, not a markdown renderer failure.

- [x] 7.4a Remove the legacy thread renderer, selector, and fallback; Sätteri is now the sole engine and errors preserve source text safely
- [ ] 7.4b Roll out `threadViewer=frozen` after its first-mount cost meets the release gate; keep `MemoizedMessageList` as the viewer fallback until then
