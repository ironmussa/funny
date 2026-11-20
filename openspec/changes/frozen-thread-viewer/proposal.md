## Why

Long threads are currently painful: scroll jumps and drifts (absolute-positioned
virtualization + estimated heights + hand-rolled anchor restoration), laggy
thread loads, and memory growth that makes long threads unusable (~20 mounted
`ReactMarkdown` fiber trees at once, full re-parse per streaming delta, tool
cards rendering full output while collapsed). Ctrl+F also cannot find messages
outside the mounted window because the virtualizer unmounts them.

A benchmark spike (`bun run bench:markdown`, commit c5fb4c05) showed Sätteri
(Rust markdown compiler) is dramatically faster than the `react-markdown`
pipeline and enables a cheaper rendering model: sanitized static HTML for
settled messages instead of per-node React trees.

## What Changes

- Add a Sätteri-based markdown engine that compiles message markdown to
  sanitized HTML strings (WASM in the browser), cached by content hash, as the
  sole thread renderer. A compiler failure preserves the source as plain text.
- Replace TanStack Virtual with a frozen-message viewer behind a `threadViewer`
  flag: settled messages render as static HTML in normal document flow; only
  the recent tail (last ~30 messages) stays live React; streaming recompiles at
  most once per animation frame.
- Interactivity on frozen rows moves to event delegation (local-file links,
  code copy, image lightbox); visualizer fences and images stay React islands.
- Scrolling becomes native browser scroll: bidirectional infinite scroll via
  IntersectionObserver sentinels (older pages up, newer pages down), native
  `overflow-anchor` position stability, per-thread position restore by anchor
  message + offset, and working find-in-page across all loaded history via
  `content-visibility: auto`.
- Tool cards inside the frozen region render a collapsed preview without
  mounting full output until expanded.
- `MemoizedMessageList` remains intact as the viewer fallback during rollout.

## Capabilities

### New Capabilities

- `safe-markdown-rendering`: compiling chat markdown to sanitized HTML with
  Sätteri — sanitization policy, feature parity (GFM, code, links, images,
  visualizer fences), content-hash caching, streaming recompile budget, and
  source-text error behavior.
- `frozen-message-rendering`: lifecycle of freezing settled messages to static
  HTML — freeze/unfreeze criteria, live tail, React islands, event-delegated
  interactivity, tool-card lazy output, memory bounds.
- `thread-scroll-navigation`: native-flow scrolling behavior — bidirectional
  infinite scroll, position persistence/restore per thread, deep links to any
  message (`expandToItem`), sticky-bottom during streaming, sticky user-message
  context, find-in-page coverage.

### Modified Capabilities

<!-- none: no existing openspec/specs capability covers the thread viewer;
     current behavior is documented in docs/architecture/thread-virtualization.md -->

## Impact

- `packages/client`: `MessageStream`, `MemoizedMessageList` (kept as viewer fallback),
  `MessageContent`, `markdown-components.tsx`, `use-message-stream-scroll.ts`,
  `render-items.ts` consumers, settings store (two new flags), new
  `lib/satteri-markdown.ts` and frozen viewer components.
- Dependencies: `satteri` moves into `packages/client` (WASM asset must ship in
  Vite + Tauri builds); a sanitizer library is added.
- Tool-call grouping (`render-items.ts`), tool card dispatch, and all
  server/runtime code are unchanged.
- Existing plan with phases and gates: `docs/plans/satteri-markdown-migration.md`.
