# Design - thread-message-virtualization

## Context

The current data path is already lazy:

- Initial thread load calls `api.getThread(threadId, 50)`.
- The repository returns the newest page plus `hasMore` and `total`.
- `ThreadSearchBar` calls `api.searchThreadMessages(...)`, so search indexes the
  full server-side history without client-side eager loading.
- Search navigation calls `MessageStreamHandle.expandToItem(messageId)`, and if
  the message is not loaded, `useThreadStore.loadMessagesUntil(...)` pages older
  messages until the target exists locally.

The rendering path is not lazy enough. `MemoizedMessageList` builds grouped
render items, mounts the newest suffix, and increases `renderCount` when the
user scrolls up or when search asks for an older item. The mounted range only
ever grows, so it eventually becomes equivalent to rendering the full loaded
history.

The scroll path is also too dependent on aggregate estimates. The current
phantom spacer uses an average loaded-message height, and scroll restoration can
fall back to proportional progress through the total scroll range. That breaks
down when a long thread contains highly variable rows: short user prompts, large
assistant markdown blocks, tool groups, images, streamed content, and expandable
cards.

The target model is measured virtual geometry:

```text
scroll viewport
┌───────────────────────────────────────────────┐
│ unloaded-before spacer: estimated server rows │
├───────────────────────────────────────────────┤
│ loaded virtual rows: estimated, then measured │
│   item key -> measured height                 │
│   virtual index -> scroll offset              │
├───────────────────────────────────────────────┤
│ unloaded-after spacer: estimated server rows  │
└───────────────────────────────────────────────┘
```

The scrollbar represents the best known geometry, but user position is preserved
by stable content identity: item key plus offset from the viewport top. Pixel
offsets and scroll percentages are fallback values, not the primary source of
truth.

## Goals / Non-Goals

**Goals**

- Bound mounted DOM nodes by viewport size plus overscan, regardless of how far
  the user scrolls or where search jumps.
- Preserve the existing lazy server data model: do not load all messages at
  thread entry.
- Preserve full-history thread search: users can cycle through all matches,
  including unloaded older messages.
- Preserve scroll behavior: bottom pinning while streaming, top pagination,
  scroll anchoring during prepend, `scrollToBottom`, prompt pinning, and visible
  user-message tracking.
- Reuse existing dependency `@tanstack/react-virtual`.

**Non-Goals**

- No backend search/indexing change.
- No change to message grouping semantics or card rendering.
- No attempt to virtualize unloaded server messages as real rows in the first
  pass; the existing phantom spacer can continue to represent unloaded history.
- No rewrite of thread store pagination.

## Decision 1 - Use tanstack virtual over grouped render items

`MemoizedMessageList` will create a virtualizer whose `count` is
`groupedItems.length`, `getScrollElement` returns the `MessageStream`
`scrollRef.current`, `getItemKey` uses the existing `getItemKey(item)`, and
`estimateSize` delegates to the existing `estimateItemHeight(...)` helper.

Rows render as a positioned stack inside a container of
`height: rowVirtualizer.getTotalSize()`. Each virtual row is translated to
`virtualRow.start` and measured with `rowVirtualizer.measureElement`.

Spacing between rows should be represented in the virtualizer geometry, either
with TanStack's `gap` option or by measuring a row wrapper that includes the
visual gap. Avoid margin-based spacing that the virtualizer cannot measure
reliably.

This replaces:

- `renderCount`
- `windowStart`
- `visibleItems = groupedItems.slice(windowStart)`
- `spacerHeight`
- `ResizeObserver`/`MutationObserver` height cache used only for the append-only
  spacer
- scroll-up expansion listener

The existing item-rendering functions remain local to `MemoizedMessageList`.

## Decision 1.1 - Estimate and measure per render item, not per message average

`estimateSize` should be derived from the grouped render item, not from a single
global average:

- user message: compact card estimate based on content/images;
- assistant message: pretext/markdown estimate when width and font metrics are
  available, otherwise a conservative fallback;
- tool call/group/run: estimate from tool kind and grouped-call count;
- thread/compaction/workflow event: small fixed estimate;
- changed-files summaries and other per-session appendages: measured as part of
  the virtual row or modeled as their own render item before virtualization.

Measured heights are cached by stable render item key. The cache is an
optimization for total-size stability and jump reduction; it must not be the
only correctness mechanism. The virtualizer remains responsible for live
measurement through `measureElement`.

Height cache entries must be invalidated or namespaced when layout-affecting
inputs change:

- scroll container width;
- global font size and line-height settings;
- compact versus full thread mode;
- message content changes during streaming;
- images/media finishing load;
- collapsible or expandable tool-card state;
- markdown/pretext measurement version changes.

## Decision 2 - Keep the imperative list handle stable

The migration should not require broad rewiring. `MemoizedMessageListHandle`
keeps the current shape:

```ts
interface MemoizedMessageListHandle {
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: () => void;
}
```

Implementation mapping:

- `expandToItem(id)` becomes `virtualizer.scrollToIndex(index, { align:
  'center' })` after resolving the current grouped-item index. It may use
  `flushSync` only when the target item has just become loaded and React needs
  to commit before DOM search highlighting runs.
- `hasHiddenItems()` returns whether the virtualizer has unmounted loaded rows
  above the visible range, not whether data is unloaded from the server. It is
  used by `MessageStream` to avoid triggering server pagination before the user
  reaches the top of the loaded virtual list.
- `captureScrollAnchor()` records the first visible mounted item key plus offset
  from the viewport top.
- `restoreScrollAnchor()` scrolls by the measured drift if the anchor is
  mounted; if it is not mounted after a prepend, it resolves the anchor key to
  an index and uses `scrollToIndex` before applying drift on the next frame.

## Decision 2.1 - Persist scroll by stable anchor, not scroll progress

Thread scroll restoration should persist a stable anchor record:

```ts
type ThreadScrollAnchor = {
  itemKey: string;
  offsetFromViewportTop: number;
  atBottom: boolean;
};
```

When a user leaves and re-enters a thread:

1. If `atBottom` is true, restore to bottom.
2. Otherwise resolve `itemKey` to the current grouped-item index.
3. Use the virtualizer to bring that item into range.
4. After the row is mounted/measured, adjust `scrollTop` by the drift between
   the row's current viewport offset and the saved offset.
5. If the item is not loaded or no longer exists, fall back to the previous
   scroll-progress behavior, then replace the saved state with a fresh anchor
   after the next scroll/measurement.

This anchor format should also be used for prepend preservation and search jump
recovery. A proportional scroll position can be retained only as a compatibility
fallback for older saved state.

## Decision 3 - Preserve the unloaded-message phantom in MessageStream

The phantom spacer represents messages that are not present in the client store
yet. The virtualizer represents only loaded grouped render items. Keeping those
two concepts separate lowers risk:

- `phantomHeight` stays above the virtualized loaded list.
- When pagination loads older messages, the phantom shrinks and the real loaded
  list grows.
- Existing anchoring around `firstMessageId` continues to own prepend
  preservation.

The phantom estimate should not depend on a single loaded-message average once
the virtualizer is in place. Prefer one of these conservative strategies:

- server-message-count estimate using a role/type distribution if available;
- measured average by render item class, such as user, assistant, tool, event;
- current average only as a bounded fallback when no better information exists.

If a later pass introduces a total-count virtual list that includes unloaded
rows, it should be proposed separately because item indexing, search target
resolution, and grouping headers all become more complex.

## Decision 4 - Search navigation remains server-side plus lazy loading

The search flow should not change:

1. `ThreadSearchBar` returns message ids from the server.
2. `useThreadSearchState.handleSearchNavigate(...)` calls `expandToItem(id)`.
3. If the target is not present in loaded messages, it calls
   `loadMessagesUntil(threadId, messageId)`.
4. Once loaded, `expandToItem(id)` scrolls the virtualizer to the row containing
   the message.
5. Highlighting runs only inside the mounted target row.

The acceptance condition is that jumping from the newest page to a match near
the beginning of a long loaded range does not mount the intermediate rows.

## Decision 5 - Sticky bottom remains owned by MessageStream

`MessageStream` continues to decide whether the user is pinned to bottom via
`userHasScrolledUp`, `scrollingToBottomRef`, and the existing 80px threshold.
The virtualized list must cooperate by:

- measuring streamed row growth with `measureElement`;
- keeping `contentStackRef` resize observation effective;
- not forcing `scrollToIndex`/`scrollToOffset` during ordinary streaming unless
  `MessageStream` asks to stay at bottom;
- preserving `scrollToBottom()` as an immediate jump to `scrollHeight`.

When the user is not pinned, streaming growth above or inside the viewport
should preserve the captured anchor rather than applying bottom pinning. When
the user is pinned, measurements that increase total size should be followed by
an explicit bottom correction from `MessageStream`.

## Decision 6 - Own browser scroll anchoring deliberately

Browser scroll anchoring can reduce jumps for ordinary documents, but it can
fight a virtualizer that is also correcting scroll offsets. The thread viewport
should explicitly choose one owner for each region:

- virtualized loaded rows: application-owned anchor restoration;
- unloaded phantom spacers: application-owned delta correction;
- unrelated surrounding layout: browser anchoring may remain enabled unless it
  creates observable double-correction.

If testing shows browser anchoring conflicts with virtualizer corrections, apply
`overflow-anchor: none` to the relevant thread scroll container or spacer rows
and keep anchoring fully application-owned.

## Sticky section headers

The current append-only list injects `hiddenSectionUserItem` when the first
visible grouped item belongs to a session whose user message is above the
window. With true virtualization, this should become a derived "current section"
lookup based on the first virtual row index:

- find the nearest preceding user-message item;
- render the same section header context when that user message is not mounted;
- keep the existing sticky header visuals and `data-user-msg` behavior for
  visible-message tracking.

This should be implemented inside `MemoizedMessageList`, not in
`MessageStream`, because it depends on grouped item indexes.

## Test Strategy

Automated coverage should focus on the migration contract rather than every
pixel of scroll physics:

- helper test: item id to grouped-index mapping includes messages, individual
  tool calls, grouped tool calls, tool-call runs, and thread events;
- helper test: preceding-section lookup returns the nearest user-message item
  for a virtual start index;
- component/browser test: a synthetic long loaded thread renders a bounded
  number of `[data-item-key]` nodes at bottom, after deep scroll, and after
  search jump;
- component/browser test: search navigation to an unloaded old message calls
  `loadMessagesUntil`, then centers/highlights the target after it is loaded;
- component/browser test: prepending older messages preserves visual anchor;
- component/browser test: streaming while pinned stays at bottom, while
  streaming after manual upward scroll does not steal position.
- component/browser test: leaving a long thread and returning restores by item
  anchor after row heights have changed.
- component/browser test: changing font size or viewport width invalidates
  stale measurements without jumping the visible anchor.

Manual verification should use a real long thread such as the reported
`HAqxZ05Sv8KJhjb4ZRyTL` thread and include desktop plus a narrow viewport.

## Rollout

Implement behind a local component boundary first. If risk is high, add a
temporary feature flag such as `VITE_THREAD_VIRTUALIZER=true` that defaults to
the new path only in development until verification passes. Remove the flag
before merging unless there is a concrete production rollout need.

## Risks

- **Scroll regressions.** Thread scroll behavior is delicate. Mitigation:
  preserve the handle API, add browser-level tests, and stage the work so the
  virtualizer swap can be reviewed independently from cleanup.
- **Dynamic height drift.** Tool output, markdown, images, and expandable cards
  can change row height after render. Mitigation: use `measureElement` and keep
  the current content-growth sticky-bottom observer.
- **Stale height cache.** A cached height from one layout can be wrong after a
  width, font, mode, or content change. Mitigation: namespace/invalidate cache
  entries by layout-affecting inputs and treat cached heights as estimates.
- **Anchor not loaded.** Persisted anchors can point to an unloaded row after a
  thread entry that only loads the newest page. Mitigation: fall back to bottom
  or progress restoration, and only lazy-load older pages for explicit user
  navigation such as search.
- **Pagination trigger timing.** `hasHiddenItems()` semantics change from
  append-window hidden rows to virtualizer hidden rows. Mitigation: explicitly
  test scrolling to the top of the loaded virtual range and loading older pages.
- **Search highlight timing.** The target row may not be mounted immediately
  after `scrollToIndex`. Mitigation: keep the existing retry loop in
  `use-thread-search.ts` and only reduce it after tests prove it is unnecessary.
