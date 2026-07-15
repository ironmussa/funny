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
  During streaming the _entire_ message re-parses per delta. With overscan 8,
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
frozen region mounts the _entire loaded history_ — frozen rows are cheap
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
- **No alternate thread renderer.** A Sätteri or WASM failure preserves the
  original message as safe plain text and emits `markdown.satteri_error`.
  `MemoizedMessageList` remains the temporary viewer fallback only.
- **Feature parity surface** (must survive): local-file links with tooltip +
  open-in-editor, `MarkdownImageCard` + lightbox, code blocks with highlight +
  copy, GFM tables/task lists, visualizer fences (mermaid, dbml, …), nested
  markdown, sticky user-message context, `expandToItem(id)` deep links,
  fork/rewind controls per message.

## Phases

### Phase 0 — Baseline and in-browser benchmark (gate)

- [x] Extend `scripts/benchmark-markdown-renderers.ts` with a browser/WASM run
      (Vite playground page or Playwright harness) on the same corpus. Record
      ops/sec and `.wasm` bundle size.
- [x] Long-thread fixture (≥500 messages, mixed markdown + tool calls) and
      baseline metrics via CDP: JS heap, DOM nodes, thread-switch time, scroll
      frame times. Lands as `scripts/profile-client.ts` (memory-optimization
      item 8).
- **Gate:** Sätteri-WASM passed the browser comparison; all thread markdown now
  uses it rather than retaining an alternate renderer.

#### Phase 0 — findings (2026-07-12)

The original native probe established candidate performance and size. The
in-browser and CDP measurements below are now the gate's source of truth.

- **Long-thread fixture — DONE.** `packages/client/src/test-fixtures/long-thread-fixture.ts`
  (`makeLongThread({ messageCount, seed, toolCallRatio })`) — deterministic
  (seeded mulberry32), mixed markdown (short / code+raw-HTML probe / table+task
  list / long prose) with interleaved tool calls, variable heights to stress
  measurement. Reusable by tests, the benchmark, and the profiler. Covered by
  `src/__tests__/lib/long-thread-fixture.test.ts`.
- **`.wasm` ship cost (`@bruits/satteri-wasm32-wasi@0.9.5`):** 2,397,591 B raw
  (~2.29 MB) → **721,534 B gzip (~705 KB)**. For comparison the current markdown
  stack (`react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-sanitize`) is
  ~100–150 KB gzip. The WASM engine adds roughly **5× the transfer size** of the
  markdown stack it replaces — the gate must weigh this against the parse win.
- **Install/build gate (affects §2.1).** The WASM binding lives in the
  `optionalDependencies` entry `@bruits/satteri-wasm32-wasi` gated to
  `cpu: wasm32`. On a normal (x64/arm64) host `bun install` records it in the
  lockfile but **does not extract its files**, so `satteri`'s `browser` export
  condition (`#binding` → `dist/binding.browser.js` → `@bruits/satteri-wasm32-wasi`)
  resolves to missing files and a Vite client build cannot bundle it as-is.
  §2.1 must force-install the wasm target (e.g. a `trustedDependencies` /
  explicit non-optional dep or a postinstall that fetches the tarball) and prove
  `bun run build` emits the `.wasm` before the engine can ship. This is the
  concrete form of the "`.wasm` asset missing in packaged builds" risk.
- **Parse-speed expectation (not yet an in-browser number).** The prior spike
  measured Sätteri **native** ~34× faster than the `react-markdown` path, but
  that path also included React static render — apples-to-oranges, since Sätteri
  only emits an HTML string that still needs sanitize + DOM insertion. NAPI-RS
  WASM bindings typically run ~1.5–3× slower than native for CPU-bound work, so
  WASM likely still beats `react-markdown` on raw parse — but the gate decision
  needs the **end-to-end in-browser** number (compile → sanitize → DOM), not a
  parse microbenchmark.

#### Phase 0 — browser findings (2026-07-14)

The initial benchmark used a dedicated production Vite page and headless
Chromium to compare the then-current renderer with Sätteri-WASM + DOMPurify on
the deterministic 100-message fixture (50 assistant markdown messages), after
four warmups and across 20 samples. Timed work included parsing, sanitization,
DOM insertion and forced layout; each sample then waited for a paint before the
next iteration. `bun run bench:markdown:browser` now exercises only the
production Sätteri path, so it remains a regression and WASM-asset check rather
than retaining the previous renderer in the benchmark bundle.

| Renderer                            |     Mean |      p95 |  Throughput |
| ----------------------------------- | -------: | -------: | ----------: |
| `react-markdown` + rehype sanitizer | 18.66 ms | 21.00 ms | 2,680 msg/s |
| Sätteri-WASM + DOMPurify            | 10.50 ms | 12.10 ms | 4,762 msg/s |

Sätteri is **1.78× faster** end-to-end in Chromium. Vite emitted the exact
WASM asset at 2,397,591 bytes raw / 732,901 bytes gzip. The browser target is
vendored at `packages/client/vendor/satteri-wasm32-wasi`: Bun otherwise skips
the upstream package because its `cpu: ["wasm32"]` declaration is not a Bun
install target. `THIRD_PARTY.md` records the upstream integrity hash and the
single manifest-only compatibility change.

The original profile against the prior implementation established the
comparison baseline. Current profiling is Sätteri-only and is recorded in
Phase 7 below. All values are controlled-fixture measurements, not a claim
about a logged-in production session.

**Gate decision: pass.** The end-to-end gain is material enough for Sätteri to
be the sole thread engine. The 733 KB gzip WASM cost still requires lazy
loading, safe source-text errors, and the distribution smoke test.

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

### Phase 3 — Integrate Sätteri as the sole thread renderer

- [x] Remove the markdown-engine setting and render every thread message through
      the Sätteri segment renderer.
- [x] Preserve message text in a safe plain-text error state if the WASM compiler
      fails; log `markdown.satteri_error` without selecting another renderer.
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

- [x] Re-run Phase 0 profiling on the fixture with `satteri` + `frozen`;
      record before/after heap, DOM nodes, fiber counts, thread-switch time,
      scroll frame times in this doc.
- [ ] Playwright: long-thread sweep (expand history to top, scroll to bottom,
      stream a new message) — no anchor loss, bounded memory, sticky-bottom
      correct.
- [ ] Distribution smoke: `bun run build`, `bun run tauri:build`, packaged app
      renders markdown (`.wasm` shipped and resolves).
- [x] Sätteri is the sole thread markdown renderer; no per-user engine flag or
      legacy fallback remains.
- [ ] Roll out `threadViewer=frozen` only after its first-mount cost meets the
      release gate. Keep `MemoizedMessageList` as the viewer fallback until then.

#### Phase 7 — preliminary profile (2026-07-14)

`profile:client` renders Sätteri only and forces a CDP garbage collection before
each snapshot. This avoids treating DOMPurify's
short-lived parser documents as retained memory. The results are controlled
500-message fixture values, not production telemetry:

| Path                | Heap before → after | DOM nodes before → after | Scroll mean / p95 | Thread switch |
| ------------------- | ------------------: | -----------------------: | ----------------: | ------------: |
| `virtual` + Sätteri |    20.23 → 22.05 MB |                455 → 555 |  19.62 / 29.80 ms |      24.60 ms |
| `frozen` + Sätteri  |    35.51 → 35.22 MB |          29,276 → 28,042 |  16.67 / 20.80 ms |     246.20 ms |

The frozen path preserves its expected scroll-frame gain, and its retained heap
is bounded after GC, but it currently mounts the full loaded DOM on a thread
switch. That makes switches roughly **10× slower** than the virtual baseline.
`threadViewer` therefore remains `virtual` by default: resolving first-mount
cost (without losing loaded-history find-in-page) is a release gate before any
frozen-viewer rollout. Sätteri is now the sole thread renderer; WASM failures
keep the original message as plain text and emit `markdown.satteri_error`.

The existing authenticated Playwright profile (`J.8`) also passed on
2026-07-14 for its 216-message fixture (both viewers, full top↔bottom sweep).
The dedicated Phase 7 suite remains open because it must additionally exercise
bidirectional pagination, per-thread restoration, streaming pinning, and the
native Ctrl+F path on a 500-message fixture.

#### Phase 7 — distribution status (2026-07-14)

`bun run build` passes and the Vite client output includes the lazily loaded
Sätteri WASM asset. The desktop package check cannot begin yet: `bun run
tauri:build` stops before compiling the app because the checked-in Rust lockfile
resolves `tauri` 2.10.2 while the root JavaScript manifest declares
`@tauri-apps/api` 2.11.1 (and CLI 2.11.4). The migration does not change those
desktop versions, so updating the Tauri toolchain is a separate prerequisite to
the packaged-app smoke test rather than a renderer change.

## Explicit non-goals (v1)

- Rewriting tool cards or `render-items.ts` grouping.
- Migrating standalone Markdown surfaces outside thread messages (for example,
  PR comment previews) as part of this change.
- Sätteri's native binding in the Bun server/sidecar (client-only).
- MDX features.
- App-level search across _unloaded_ history (Ctrl+F covers everything loaded;
  a store/backend-backed thread search box is a follow-up plan).

## Verification

- `bun run lint`, `bun run typecheck` per change.
- XSS fixtures and Sätteri feature snapshots green before shipping.
- `e2e/thread-long-history.spec.ts` covers a 500-message windowed history,
  bidirectional pagination, reading-position restore, and native Ctrl+F; it
  still needs an authenticated API server to run and a streaming-pin assertion
  before `frozen` can default on.
- Tauri 2.11.1 matches the JavaScript API. Linux `.deb`/`.rpm` packaging reaches
  the bundle stage with the Sätteri asset embedded; AppImage requires a clean
  Linux packaging image because the local `linuxdeploy` GTK plugin aborts while
  running `ldd` on a host library.
- Before/after profile numbers from `scripts/profile-client.ts` recorded here.
