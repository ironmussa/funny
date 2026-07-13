# Plan: Sätteri Markdown Migration + Frozen-Message Thread Viewer

## Goal

Two coupled changes that together fix the three symptoms reported in long
threads (scroll jumps/drift, laggy loads, memory growth that makes long threads
unusable):

1. Replace the per-message `react-markdown` pipeline with **Sätteri**
   (Rust/WASM markdown compiler) producing sanitized HTML strings.
2. Replace TanStack Virtual with a **frozen-message viewer**: settled messages
   render as static HTML (one DOM subtree, no React fibers per node), only the
   recent tail is mounted as live React, history loads with bidirectional
   infinite scroll, and `content-visibility: auto` skips layout/paint of
   off-screen frozen rows. Scroll becomes native browser scroll — no absolute
   positioning, no manual anchors, no settle windows.

This plan supersedes the earlier "improve the virtualizer" direction and
absorbs items 4, 7, 8 of [memory-optimization.md](./memory-optimization.md).

## Diagnosis (why the current viewer is slow)

- **Per-message React markdown trees.** Every assistant message mounts
  `ReactMarkdown` (`MessageContent.tsx`) → remark parse → mdast → hast → a full
  React element tree with per-node overrides (`markdown-components.tsx`).
  During streaming the *entire* message re-parses per delta. With overscan 8,
  ~20 such trees are mounted at once, each retaining fibers, props, and
  highlight HTML state.
- **Absolute-positioned virtualization → scroll weirdness.** TanStack rows live
  outside document flow (`position: absolute` + `translateY`), heights are
  estimated then corrected, and reading position is preserved by hand-rolled
  anchors (`captureScrollAnchor`/`restoreScrollAnchor`) plus a 700ms
  `THREAD_SWITCH_SETTLE_MS` window that exists to paper over the re-measurement
  storm. Native browser scroll anchoring (`overflow-anchor`) cannot help
  because rows are not in flow.
- **Tool card DOM weight.** Long Bash/Read/Write outputs render fully even when
  collapsed (memory-optimization item 4).

## Target architecture

```
MessageStream (native scroll, overflow-anchor active)
├── top sentinel (IntersectionObserver)    ← loads older pages (hasMore)
├── FrozenRegion — ALL loaded settled messages, in normal flow
│   └── row: sanitized HTML via dangerouslySetInnerHTML
│        content-visibility: auto + contain-intrinsic-size (cached height)
│        interactivity via ONE delegated listener on the region
│        (file links, copy buttons, image lightbox)
│        tool cards: React but collapsed-by-default preview, output not mounted
├── LiveTail (last N messages)             ← normal React rendering
│   └── streaming message: Sätteri recompile throttled to rAF
└── bottom sentinel (IntersectionObserver) ← loads newer pages (hasMoreAfter)
```

Freeze criteria: a message row freezes when its message is complete (not
streaming) AND it falls out of the live tail (last N messages, N ≈ 30). The
frozen region mounts the *entire loaded history* — frozen rows are cheap
enough (no fibers, layout/paint skipped off-screen) that there is no mount
cap. This also restores **native find-in-page**: `content-visibility: auto`
content stays searchable with Ctrl+F, unlike the current virtualizer which
unmounts off-screen rows entirely. Frozen HTML comes from the same
`renderMarkdownToSafeHtml` cache, so freezing is an innerHTML assignment, not
a re-parse. Tool call rows are NOT frozen to HTML (they are interactive React
cards) but live inside the frozen region with `content-visibility` and lazy
output mounting.

## Key constraints

- **Browser = WASM, not native.** The 34x `bench:markdown` result ran on Bun
  with the native `.node` binding. `packages/client` runs in the browser, where
  Sätteri loads `@bruits/satteri-wasm32-wasi`. Phase 0 must re-benchmark
  in-browser and measure the `.wasm` bundle-size impact before committing.
- **Sanitization is mandatory.** The benchmark probe confirmed Sätteri
  preserves raw executable HTML (`onerror`). Its output must never reach
  `dangerouslySetInnerHTML` unsanitized.
- **Fallback stays during transition.** `react-markdown` remains reachable
  behind an error boundary; the current `MemoizedMessageList` remains the
  viewer fallback behind a flag until the frozen viewer passes the long-thread
  validation. Mirrors the `@funny/native-git` pattern.
- **Feature parity surface** (must survive): local-file links with tooltip +
  open-in-editor, `MarkdownImageCard` + lightbox, code blocks with highlight +
  copy, GFM tables/task lists, visualizer fences (mermaid, dbml, …), nested
  markdown, sticky user-message context, `expandToItem(id)` deep links,
  fork/rewind controls per message.

## Phases

### Phase 0 — Baseline and in-browser benchmark (gate)

- [ ] Extend `scripts/benchmark-markdown-renderers.ts` with a browser/WASM run
  (Vite playground page or Playwright harness) on the same corpus. Record
  ops/sec and `.wasm` bundle size.
- [ ] Long-thread fixture (≥500 messages, mixed markdown + tool calls) and
  baseline metrics via CDP: JS heap, DOM nodes, thread-switch time, scroll
  frame times. Lands as `scripts/profile-client.ts` (memory-optimization
  item 8).
- **Gate:** if Sätteri-WASM is not clearly faster than `react-markdown` in the
  browser, keep the frozen-viewer phases (5–7, they work with any HTML source —
  the current pipeline can pre-render to HTML too) and drop the parser swap.

### Phase 1 — Safe render layer

- [ ] Move `satteri` from root devDependencies into `packages/client`
  dependencies; verify Vite bundles the wasi-browser path (dev + `bun run
  build` + preview).
- [ ] `packages/client/src/lib/satteri-markdown.ts`:
  `renderMarkdownToSafeHtml(content: string): string` = Sätteri compile →
  allow-list sanitizer (same effective policy as the current `rehype-sanitize`
  schema) → HTML string.
- [ ] LRU cache keyed by content hash, capped by total bytes (not entry count).
  This cache later powers freezing (Phase 5) and height hints (Phase 6).
- [ ] Unit tests: XSS fixture corpus (script/iframe/onerror/`javascript:`
  URLs), GFM features, cache eviction.

### Phase 2 — Parity via segments + event delegation

- [ ] **Segment splitter:** pre-scan for fenced blocks that need React
  (visualizers, nested markdown, `MarkdownImageCard` images). Split into `html`
  segments (Sätteri) and `island` segments (existing components). Plain
  messages stay single-segment.
- [ ] **Event delegation** (one listener at region level): local-path links →
  open-in-editor (port from `MessageContent.tsx`), code copy buttons, image →
  lightbox.
- [ ] **Code highlighting:** post-process `<pre><code class="language-x">` with
  existing `highlightCode`, deferred to idle.
- [ ] Snapshot parity tests: real-message corpus rendered by both engines;
  diff semantic output (links, tables, task lists, code blocks).

### Phase 3 — Integrate into MessageContent behind a flag

- [ ] Settings flag `markdownEngine: 'legacy' | 'satteri'` (default `legacy`).
- [ ] `MessageContent` uses the segment renderer when on, wrapped in an error
  boundary falling back to `LazyMarkdownRenderer`; log
  `markdown.satteri_fallback`.
- [ ] Streaming: throttle recompile to one per animation frame; measure before
  optimizing further (WASM compile of one message should be sub-ms).

### Phase 4 — WebFetch/WebSearch tool outputs

- [ ] The only markdown path inside tool cards (`ToolCallCard` markdown branch)
  switches to the same safe renderer. `dispatchToolCard`, grouping, and
  `render-items.ts` do not change.

### Phase 5 — FrozenMessage: settled messages become static HTML

- [ ] `FrozenMessage` component: renders `renderMarkdownToSafeHtml` output via
  `dangerouslySetInnerHTML` inside the delegated-events region. No
  `ReactMarkdown`, no per-node fibers. Islands (visualizers/images) stay as
  small React portals within the frozen row.
- [ ] Freeze criteria: message complete AND outside the live tail (last N,
  start with N = 30). Unfreeze on demand (e.g., user opens fork/rewind controls
  → row swaps back to live rendering; controls chrome itself stays React).
- [ ] Tool cards in frozen region: collapsed-by-default preview, full output
  NOT mounted until expanded (memory-optimization item 4).
- [ ] Test: long-thread fixture renders with bounded fiber count; interaction
  (link click, copy, lightbox) works on frozen rows.

### Phase 6 — Replace the virtualizer: in-flow rendering + bidirectional infinite scroll

- [ ] Viewer flag `threadViewer: 'virtual' | 'frozen'` (default `virtual`).
- [ ] New list renderer: all mounted rows in normal document flow (no
  `position: absolute`, no `scrollMargin`, no TanStack). Native
  `overflow-anchor` keeps reading position during prepends/streaming; delete
  manual anchor capture/restore and the settle window on this path.
- [ ] Bidirectional infinite scroll via IntersectionObserver sentinels: top
  sentinel loads older pages (`hasMore`), bottom sentinel loads newer pages
  (`hasMoreAfter`) when positioned mid-thread. Reuses the existing windowed
  pagination in `thread-store` (`windowStart`, `total`); replaces the
  scrollTop-threshold logic in `use-message-stream-scroll.ts`.
- [ ] **Per-thread position restore**: persist anchor message id + pixel
  offset on leave; on re-entry, load the message window around the anchor
  (`windowStart` supports arbitrary offsets) and scroll straight to it.
  Stable frozen heights make this deterministic — no settle window. Covers
  switch-away/switch-back and deep links into the middle of a thread.
- [ ] `content-visibility: auto` + `contain-intrinsic-size` on frozen rows,
  fed by the existing height cache (this was the known blocker for
  `content-visibility` on variable rows — frozen rows have stable, known
  heights). Verify find-in-page (Ctrl+F) hits frozen off-screen rows.
- [ ] Port required behaviors: `expandToItem(id)` → load window around the
  target, then `scrollIntoView`; sticky user-message context; sticky-bottom
  during streaming (scroll to bottom on new content unless user scrolled up —
  reimplemented on native scroll, drastically simpler than the current
  metrics-based version).
- [ ] Keep `MemoizedMessageList` untouched as the `virtual` fallback path.

### Phase 7 — Validation, rollout, distribution

- [ ] Re-run Phase 0 profiling on the fixture with `satteri` + `frozen`;
  record before/after heap, DOM nodes, fiber counts, thread-switch time,
  scroll frame times in this doc.
- [ ] Playwright: long-thread sweep (expand history to top, scroll to bottom,
  stream a new message) — no anchor loss, bounded memory, sticky-bottom
  correct.
- [ ] Distribution smoke: `bun run build`, `bun run tauri:build`, packaged app
  renders markdown (`.wasm` shipped and resolves).
- [ ] Rollout order: `markdownEngine=satteri` first (dev → default), then
  `threadViewer=frozen` (dev → default). Watch `markdown.satteri_fallback`.
  Keep both fallbacks for at least one release; removal of react-markdown and
  `MemoizedMessageList` is a separate follow-up plan.

## Explicit non-goals (v1)

- Rewriting tool cards or `render-items.ts` grouping.
- Removing `react-markdown` or `MemoizedMessageList` from the tree.
- Sätteri's native binding in the Bun server/sidecar (client-only).
- MDX features.
- App-level search across *unloaded* history (Ctrl+F covers everything loaded;
  a store/backend-backed thread search box is a follow-up plan).

## Verification

- `bun run lint`, `bun run typecheck` per change.
- XSS fixtures and engine-parity snapshots green before `satteri` defaults on.
- Long-thread Playwright suite green before `frozen` defaults on.
- Before/after profile numbers from `scripts/profile-client.ts` recorded here.
