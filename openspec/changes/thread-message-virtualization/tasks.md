## 1. Baseline and guardrails

- [x] 1.0 Reconcile this task list with the current source before implementation
      resumes. As of this exploration pass, `MemoizedMessageList.tsx` still
      contains append-only windowing markers such as `INITIAL_WINDOW`,
      `renderCount`, `windowStart`, and `spacerHeight`, so checked items in
      sections 3-4 must be verified against code rather than trusted as done.
- [ ] 1.1 Add or identify a repeatable long-thread fixture/dev path with hundreds
      of grouped render items, tool cards, markdown, and at least one old search
      match.
- [ ] 1.2 Record current behavior for the fixture: initial loaded message count,
      mounted `[data-item-key]` count at bottom, mounted count after deep scroll, and
      mounted count after jumping to an old search result.
- [ ] 1.3 Add a focused regression test for server-side search navigation that
      confirms unloaded matches still call `loadMessagesUntil(...)`.

## 2. Extract virtualizer-safe helpers

- [x] 2.1 Extract the grouped-item id-to-index map into a pure helper near
      `render-items` or inside `MemoizedMessageList` with exported tests.
- [x] 2.2 Extract the nearest preceding user-message lookup used for sticky
      section context.
- [x] 2.3 Test messages, tool calls, grouped tool calls, tool-call runs, thread
      events, and missing ids.
- [ ] 2.4 Extract a virtual scroll anchor helper that captures `{ itemKey,
      offsetFromViewportTop, atBottom }`, resolves item keys to grouped indexes,
      and computes post-render drift.
- [ ] 2.5 Extract or centralize height-estimate helpers by render item type so
      estimates do not depend on a single global loaded-message average.

## 3. Introduce tanstack virtualization in MemoizedMessageList

- [x] 3.1 Import `useVirtualizer` from `@tanstack/react-virtual` and configure it
      over `groupedItems.length` with `getScrollElement`, `getItemKey`,
      `estimateSize`, and an overscan tuned for message streams.
- [x] 3.2 Replace `renderCount`, `windowStart`, `visibleItems`, append-only
      spacer height, and scroll-up expansion effects with `virtualizer.getVirtualItems()`.
- [x] 3.3 Render virtual rows in a total-size container and attach
      `measureElement` to each `[data-item-key]` row.
- [x] 3.4 Preserve current row/card markup, data attributes, memo comparator
      behavior, and compact-mode spacing.
- [ ] 3.5 Keep pretext warm-up, but avoid preparing more text than needed during
      initial mount if profiling shows it still scans too much for huge loaded
      histories.
- [x] 3.6 Represent inter-row spacing inside virtual geometry (`gap` or measured
      row wrappers), avoiding margin-only spacing that is invisible to row
      measurement.
- [ ] 3.7 Cache measured row heights by stable render item key and invalidate or
      namespace measurements by viewport width, font size, compact/full mode,
      content revision, and expandable card state.
- [ ] 3.8 Ensure media load, markdown/pretext readiness, streaming updates, and
      tool-card expand/collapse all trigger remeasurement for affected virtual
      rows.

## 4. Preserve imperative scroll/search API

- [x] 4.1 Reimplement `expandToItem(id)` as `scrollToIndex` using the helper map.
- [x] 4.2 Reimplement `hasHiddenItems()` from the virtualizer visible range so
      server pagination does not fire until the user reaches the top of loaded
      content.
- [x] 4.3 Reimplement `captureScrollAnchor()` and `restoreScrollAnchor()` for
      virtual rows, including the case where the anchor row is temporarily unmounted.
- [ ] 4.4 Verify `use-thread-search.ts` can still find, highlight, and center the
      target after the virtualizer mounts it.
- [ ] 4.5 Replace thread scroll restoration's primary saved state from
      proportional scroll progress to stable item anchor plus viewport offset,
      retaining scroll progress only as a fallback for legacy or missing anchors.
- [ ] 4.6 Verify anchor restoration after switching away from and back to a long
      thread whose row heights changed while it was not visible.

## 5. Preserve MessageStream behavior

- [ ] 5.1 Keep the unloaded-history phantom spacer in `MessageStream` and verify
      it still shrinks when older pages load.
- [x] 5.2 Update the top-pagination trigger if the new `hasHiddenItems()`
      semantics require a different threshold.
- [ ] 5.3 Verify `scrollToBottom()`, sticky bottom while streaming, waiting-state
      attention scroll, prompt pinning, and the scroll-down button.
- [ ] 5.4 Verify `onVisibleMessageChange` still tracks visible user messages and
      timeline navigation remains correct.
- [ ] 5.5 Replace the unloaded-history phantom's single global average with a
      bounded estimate strategy based on role/item type when possible.
- [x] 5.6 Test whether browser scroll anchoring double-corrects virtualizer or
      phantom spacer adjustments; apply `overflow-anchor: none` only to the
      conflicting thread container/spacer surfaces if needed.

## 6. Tests

- [x] 6.1 Unit tests for id-to-index and section-context helpers.
- [ ] 6.2 Component/browser test: long loaded thread keeps mounted
      `[data-item-key]` rows bounded at bottom, after deep scroll, and after a
      search jump.
- [ ] 6.3 Component/browser test: jumping to an unloaded old search result loads
      pages lazily, mounts only the target neighborhood, and highlights the match.
- [ ] 6.4 Component/browser test: prepending older messages preserves the visual
      anchor and does not jump the reader.
- [ ] 6.5 Component/browser test: streaming growth while pinned remains at
      bottom; streaming growth after user scroll-up does not steal scroll.
- [ ] 6.6 Component/browser test: saved item-anchor restoration survives changed
      total scroll height and changed row heights.
- [ ] 6.7 Component/browser test: font-size or viewport-width changes invalidate
      stale measurements and preserve the current reading anchor.

## 7. Manual verification

- [ ] 7.1 Open the reported long thread
      `/projects/mxPM11AYCXzEy_jraym23/threads/HAqxZ05Sv8KJhjb4ZRyTL`.
- [ ] 7.2 Confirm initial entry loads the newest page and keeps DOM count bounded.
- [ ] 7.3 Search for text near the beginning of the thread, cycle through matches,
      and confirm old matches are reachable without mounting the whole loaded range.
- [ ] 7.4 Scroll to top repeatedly until older pages load; confirm no jump and no
      unbounded DOM growth.
- [ ] 7.5 Run the same checks in compact/grid column mode and a narrow viewport.
- [ ] 7.6 Leave and re-enter the thread while reading away from the bottom; confirm
      restoration returns to the same visible item, not the same percentage of
      the recomputed scroll range.

## 8. Cleanup

- [x] 8.1 Remove obsolete append-only window constants and comments.
- [x] 8.2 Remove dead height-cache/spacer code that tanstack now owns.
- [x] 8.3 Run client typecheck/build and the affected test suites.
- [x] 8.4 Update this task list with the actual verification commands and results.

Verification run:

- `bun --cwd packages/client test src/__tests__/lib/render-items.test.ts src/__tests__/components/MemoizedMessageList.test.tsx` - passed, 31 tests.
- `bun run --cwd packages/client build` - passed (`tsc -b && vite build`); emitted existing chunk/dynamic-import warnings only.
- `bunx oxlint packages/client/src/components/thread/MemoizedMessageList.tsx packages/client/src/lib/render-items.ts packages/client/src/__tests__/components/MemoizedMessageList.test.tsx packages/client/src/__tests__/lib/render-items.test.ts` - warnings only for existing `_planText`/`_childToolCalls` naming and existing oversized component.
- `bun --cwd packages/client test src/__tests__/components/MemoizedMessageList.test.tsx` - passed, 1 test.
- `bun --cwd packages/client build` - passed; emitted existing Vite chunk/dynamic-import warnings only.
- `bun run lint` - passed; repo emitted existing lint warnings and boundary checks reported no new violations.
- `bun run typecheck` - passed under the repo baseline gate; reported no new typecheck errors.
- `npx react-doctor@latest --verbose --scope changed` - passed with score 74; remaining warnings are structural/existing cleanup items.
- `openspec validate thread-message-virtualization --strict` - passed.
- `bun --cwd packages/client test src/__tests__/components/MemoizedMessageList.test.tsx src/__tests__/components/MessageStream.test.tsx` - passed, 8 tests.
- `bun --cwd packages/client build` - passed; emitted existing Vite chunk/dynamic-import warnings only.
- `bun run lint` - passed; repo emitted existing warnings and boundary checks reported no new violations.
- `bun run typecheck` - passed under the repo baseline gate; reported no new typecheck errors.
- `npx react-doctor@latest --verbose --scope changed` - passed with score 74; remaining warnings are structural/existing cleanup items.
