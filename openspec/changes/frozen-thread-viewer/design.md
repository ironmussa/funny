## Context

The thread viewer virtualizes rows with TanStack Virtual
(`MemoizedMessageList`): absolute-positioned rows, estimated-then-measured
heights, hand-rolled scroll anchors, and a 700ms thread-switch settle window.
Every assistant message mounts a full `ReactMarkdown` tree
(`MessageContent.tsx` + `markdown-components.tsx`) that re-parses the whole
message on each streaming delta. Symptoms in long threads: scroll jumps/drift,
laggy loads, unbounded memory, and Ctrl+F blind to unmounted rows.

A spike (`bun run bench:markdown`) showed Sätteri (Rust markdown compiler,
`optionalDependencies` with prebuilt `.node` binaries + WASI fallback) is ~34x
faster than the `react-markdown` pipeline on Bun-native, and confirmed its raw
output preserves executable HTML — sanitization is mandatory.

Detailed phase plan with gates: `docs/plans/satteri-markdown-migration.md`.
Current viewer behavior reference: `docs/architecture/thread-virtualization.md`.

## Goals / Non-Goals

**Goals:**

- Bounded React/memory footprint independent of thread length.
- Native, predictable scroll: no manual anchors, no settle window.
- Bidirectional infinite scroll and deterministic per-thread position restore.
- Ctrl+F across all loaded history.
- Sanitized-by-construction Sätteri HTML path with a safe source-text error state.

**Non-Goals:**

- Rewriting tool cards or `render-items.ts` grouping.
- Removing `MemoizedMessageList` (kept as the flagged viewer fallback).
- Sätteri on the Bun server/sidecar (client-only).
- MDX. App-level search over unloaded history (follow-up).

## Decisions

1. **Sätteri compiles to an HTML string; React does not walk markdown nodes.**
   Alternative considered: keep `react-markdown` and only virtualize harder.
   Rejected: the per-node React tree is itself the memory/CPU cost, and the
   spike showed the parse cost gap. The HTML-string model also makes freezing
   (decision 3) possible at all.

2. **Sanitizer sits between Sätteri and the DOM, always.** Allow-list
   sanitization (DOMPurify-class) with a policy mirroring the current
   `rehype-sanitize` schema. Alternative: trust Sätteri output — rejected, the
   spike demonstrated `onerror` passthrough. XSS fixtures are a release gate.

3. **Freeze settled messages; keep a live React tail.** Complete messages
   outside the last ~30 render as one `dangerouslySetInnerHTML` subtree;
   interactivity via event delegation; visualizers/images stay React islands;
   fork/rewind unfreezes a row on demand. Alternative considered: in-flow
   placeholder virtualization (cached-height empty divs + hydration on
   intersect) — rejected: keeps the height-cache complexity and breaks Ctrl+F.

4. **Mount everything loaded; let `content-visibility: auto` do the skipping.**
   `contain-intrinsic-size` is fed by measured heights (frozen rows are
   stable, which was the known blocker for using content-visibility on
   variable tool rows). This is what restores find-in-page. Alternative: hard
   tail cap with explicit "show earlier" — rejected per product requirement
   (infinite scroll both directions, full-thread Ctrl+F).

5. **Native `overflow-anchor` replaces manual anchoring.** In-flow rows make
   browser scroll anchoring effective during prepends and streaming growth.
   The settle window and `captureScrollAnchor`/`restoreScrollAnchor` are not
   ported to the frozen path.

6. **Bidirectional IntersectionObserver sentinels reuse existing pagination.**
   `hasMore`/`hasMoreAfter`/`windowStart` already exist in `thread-store`; only
   the trigger mechanism changes (sentinels instead of scrollTop thresholds in
   `use-message-stream-scroll.ts`).

7. **Position restore = anchor message id + pixel offset, persisted per
   thread.** On re-entry the window around the anchor loads first, then a
   direct scroll restores. Bottom-pinned state is stored explicitly.
   Alternative: scroll progress ratio (current approach) — rejected as
   nondeterministic when heights change.

8. **Sätteri is the only thread renderer; the viewer remains independently
   gated.** A render or WASM-load failure emits `markdown.satteri_error` and
   safely presents the source text rather than selecting a second markdown
   engine. `threadViewer: virtual|frozen` remains independent with
   `MemoizedMessageList` untouched until the frozen path meets its release gate.

9. **Browser runs the WASM build.** The 34x figure is Bun-native; Phase 0 of
   the plan re-benchmarks WASM in-browser and gates the engine swap. If the
   gate fails, the frozen viewer still proceeds using the current pipeline as
   HTML source (pre-rendered), since freezing is engine-agnostic.

## Risks / Trade-offs

- [WASM slower than expected in browser] → Phase 0 gate; frozen viewer is
  engine-agnostic and proceeds regardless.
- [Sanitizer gap → XSS] → allow-list (not deny-list) policy, XSS fixture corpus
  as CI gate, sanitize-at-the-boundary API shape (`renderMarkdownToSafeHtml` is
  the only exported path).
- [content-visibility quirks across browsers/zoom (scrollbar jitter, find
  edge cases)] → heights come from real measurements; Playwright long-thread
  suite covers sweep + Ctrl+F; `virtual` fallback flag stays.
- [Event delegation misses a legacy interaction] → parity snapshot tests over a
  real-message corpus; islands keep the complex cases (visualizers, images) on
  the existing components.
- [Sticky user-message context reimplementation] → known-tricky area (see
  `MemoizedMessageList` sticky handoff); port it with its own tests before
  flipping the default.
- [`.wasm` asset missing in packaged builds] → distribution smoke
  (`bun run build`, `tauri:build`) is a release gate; runtime load failure
  preserves the unformatted source text and reports `markdown.satteri_error`.
- [Two viewers to maintain during transition] → time-boxed: flags default on
  after validation; removal is a scheduled follow-up change.

## Migration Plan

1. Land Sätteri as the only thread engine; watch `markdown.satteri_error`.
2. Land frozen viewer behind `threadViewer=virtual` default; enable in dev;
   run long-thread Playwright suite and profiling comparison
   (`scripts/profile-client.ts`).
3. After the long-thread release gates, flip `threadViewer=frozen` default.
4. Rollback applies to the viewer flag only; no data migrations are involved.

## Open Questions

- Live-tail size N: start at 30; validate against fork/rewind usage patterns
  mid-thread.
- Sanitizer choice: DOMPurify vs a hast-based pass using Sätteri's HAST plugin
  hooks (would avoid a second HTML parse). Decide in Phase 1 with numbers.
- Whether frozen rows re-freeze after an unfreeze interaction ends, or stay
  live until the thread unmounts (simpler; likely fine).
