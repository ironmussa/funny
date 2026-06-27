# Thread virtualization handoff

This document explains how the thread message timeline is virtualized, what
contracts it depends on, and the edge cases that matter when debugging scroll
bugs. It is written as a handoff for an agent that needs to change or repair the
current implementation.

## Scope

There are two different virtualized thread UIs:

- `packages/client/src/components/thread/MessageStream.tsx` plus
  `packages/client/src/components/thread/MemoizedMessageList.tsx`: the
  conversation timeline inside one active thread. This is the main subject of
  this document.
- `packages/client/src/components/VirtualThreadList.tsx`: the sidebar/list view
  of many thread rows. It also uses `@tanstack/react-virtual`, but it is a
  separate, simpler list and should not be confused with the message timeline.

The message timeline has two layers of virtualization:

- DOM virtualization: only the visible message/event/tool rows are mounted.
  This is owned by `MemoizedMessageList`.
- Data-window virtualization: only a window of messages may be loaded from the
  backend. `MessageStream` keeps the scrollbar tied to the loaded window and
  asks the store to load older/newer pages when the user reaches the real edges
  of that window.

## Important files

- `packages/client/src/components/thread/ThreadConversation.tsx`: passes the
  active thread, pagination contract, event data, snapshots, and callbacks into
  `MessageStream`.
- `packages/client/src/components/thread/MessageStream.tsx`: owns the scroll
  viewport, sticky-bottom behavior, per-thread scroll restoration, pagination
  triggers, and loaded-window edge detection.
- `packages/client/src/components/thread/MemoizedMessageList.tsx`: turns loaded
  thread data into virtual rows and renders only the rows returned by TanStack
  Virtual.
- `packages/client/src/lib/render-items.ts`: normalizes raw messages, tool
  calls, thread events, and compaction events into render items.
- `packages/client/src/lib/thread-scroll-position.ts`: persists per-thread
  scroll progress in localStorage.
- `packages/client/src/stores/thread-store.ts`: implements `loadOlderMessages`
  and `loadNewerMessages`.
- `packages/client/src/__tests__/components/MemoizedMessageList.test.tsx`: unit
  coverage for mounted-row bounds, sticky section context, and measurement
  behavior.
- `packages/client/src/__tests__/components/MessageStream.test.tsx`: unit
  coverage for sticky bottom and per-thread scroll restoration.

## Data flow

1. `ThreadConversation` reads `activeThread` and passes `activeThread.messages`,
   `threadEvents`, `compactionEvents`, and pagination metadata into
   `MessageStream`.
2. `MessageStream` renders the scroll viewport. Inside the viewport it renders:
   top grow spacer, optional pagination indicator, optional beginning marker,
   init info, `MemoizedMessageList`, status tail, optional prompt-pin spacer,
   and sticky footer.
3. `MemoizedMessageList` calls `buildGroupedRenderItems(messages, threadEvents,
compactionEvents)`.
4. The grouped render items are converted to `virtualRows`. Most rows wrap one
   render item. Extra `session-summary` rows can be inserted after a user
   message section when `sessionChanges` has changed-file summaries for that
   user message.
5. TanStack Virtual receives `virtualRows.length`, stable row keys, an estimated
   height function, a measured-height cache, a gap, overscan, and a scroll
   margin.
6. Only `rowVirtualizer.getVirtualItems()` are mounted. Each mounted row is an
   absolutely positioned element translated to `virtualItem.start -
listScrollMargin`.

## Render item rules

`buildGroupedRenderItems` is an important part of the virtualized contract. The
virtualizer does not render raw messages directly.

- Message rows are emitted only when `msg.content.trim()` is non-empty, unless
  the message has `ExitPlanMode`. Empty assistant placeholders are skipped until
  real content or relevant tool calls exist.
- `Think` tool calls are emitted before assistant text so thinking appears above
  the response.
- `EnterPlanMode` is skipped.
- `ExitPlanMode` gets `_planText` from the most recent plan-file `Write` tool
  call, or from the assistant message content as fallback.
- Child tool calls with `parentToolCallId` are skipped as top-level rows and can
  be attached to `Task` or `Agent` parent cards.
- Consecutive same-name tool calls are grouped unless the tool is interactive
  (`AskUserQuestion` or `ExitPlanMode`).
- Earlier `TodoWrite` rows are deduplicated; only the latest todo row remains.
- Adjacent tool rows are wrapped into a single `toolcall-run` row for tighter
  spacing.
- Workflow events with the same `workflowId` become one
  `workflow-event-group`.
- `git:changed`, `compact_boundary`, and `changed_files_summary` thread events
  are not standalone timeline rows. Changed-file summaries are consumed through
  `sessionChanges`.
- Thread events and compaction events are merged with message/tool items and
  sorted by timestamp.

This means the number of virtual rows can differ from `messages.length` by a
large amount. Any logic that assumes one message equals one virtual row is
wrong.

## Row keys and lookup maps

Stable row keys are required for measurement, anchoring, and imperative scroll.

- Message row key: `msg.id`.
- Single tool call row key: `tc.id`.
- Tool-call group row key: first call id in the group.
- Tool-call run row key: first tool item id in the run.
- Thread event row key: `event.id`.
- Compaction event row key: `compact-${timestamp}`.
- Workflow group row key: `workflow-${firstEvent.id}`.
- Session summary row key: `session-summary-${userMessageId}`.

`MemoizedMessageList` builds two maps:

- `rowKeyIndexMap`: row key to virtual row index. Used by anchor restoration.
- `itemIndexMap`: message/tool/event id to virtual row index. Used by
  `expandToItem`. Multiple tool ids may point to the same grouped or run row.

## Height estimation and measurement

The virtualizer needs an estimated height before rows are mounted, then replaces
estimates with measured values.

Constants:

- row gap: `16px`.
- overscan: `8` rows.
- user message estimate: `80px`.
- assistant message fallback estimate: `120px`.
- tool call, tool group, thread event, compaction event, workflow group
  estimates: usually `32px` to `44px`.
- session summary estimate: `72px`.

Assistant message estimation tries to use pretext layout when possible:

1. The list observes its container width.
2. It warms up pretext in idle time with assistant plain text.
3. If pretext is ready and the width is greater than `100px`, it estimates prose
   height using the current prose font and line height.
4. It adds code block height, markdown extra height, and fixed chrome.
5. If pretext is not ready, it falls back to `120px`.

Measured heights are stored in `heightCache` by row key. The cache is cleared
when this layout key changes:

```text
threadId:globalFontSize:roundedContainerWidth
```

`measureElement` prefers `ResizeObserverEntry.borderBoxSize.blockSize`. It only
falls back to `getBoundingClientRect().height` when border-box size is not
available. This matters because borders and dynamic content can make content-box
measurements wrong.

After layout-sensitive changes, the list calls `rowVirtualizer.measure()` during
layout and then again across two animation frames. This catches delayed
markdown/tool-card layout and width-dependent text wrapping.

## Scroll margin

The virtualized list is not the first child of the scroll viewport. It can be
below the top grow spacer, loading indicator, beginning marker, and init card.
TanStack Virtual therefore needs a `scrollMargin`.

`MemoizedMessageList` computes:

```text
container.top - viewport.top + viewport.scrollTop
```

The result is rounded and stored as `listScrollMargin`. Rows are translated by:

```text
virtualItem.start - listScrollMargin
```

The margin is recomputed on layout, viewport/container resize, mutations in the
content stack, and scroll. If the DOM hierarchy around `itemContainerRef`
changes, this is a high-risk area because the current code derives a
`contentStack` through parent elements.

## Sticky section context

User messages act as section headers for the work that follows. When the
currently visible virtual row belongs to a section whose user message is above
the viewport, `MemoizedMessageList` renders a duplicate sticky user card at the
top.

Important details:

- The duplicate has `data-testid="sticky-section-context"`.
- It is not counted as a measured row.
- It does not set `data-item-key`.
- It does not set `data-user-msg`.
- Its z-index is above normal virtual rows.

The owner is determined from the first visible row. If that row is not a user
message, the code finds the nearest preceding user message in the grouped render
items. A small epsilon prevents flicker when the user message is exactly aligned
with the top.

## Content visibility

Do not re-add `contentVisibility: auto` to messages or variable-height tool
rows. A previous optimization caused a real bug:

1. The server inserted an empty assistant placeholder.
2. Chrome remembered the small rendered slot.
3. The websocket updated the same message id with real content.
4. React rendered the subtree, but Chrome skipped repaint for the old slot.
5. The user saw status updates but no assistant text until a forced paint.

The current code only uses `contentVisibility: auto` for small event cards where
the height is stable enough.

## Imperative API

`MemoizedMessageListHandle` exposes:

- `expandToItem(id)`: scrolls the virtualizer to the row containing the message,
  tool call, or event id.
- `hasHiddenItems()`: true when the first loaded virtual row is not mounted.
  `MessageStream` uses this to avoid loading older backend pages while the user
  is still scrolling through already-loaded but virtualized rows.
- `captureScrollAnchor()`: records the first mounted virtual row that intersects
  the viewport top and its offset from the viewport top.
- `restoreScrollAnchor()`: after rows are prepended, finds the same row and
  adjusts `scrollTop` by the measured drift. If the row is currently unmounted,
  it scrolls to the row index first, then applies drift on the next animation
  frame.

If an anchor key no longer exists after data changes, the anchor is cleared.

## Scroll ownership in MessageStream

`MessageStream` owns the actual scroll element. It disables browser anchoring and
scroll chaining:

```tsx
style={{
  overscrollBehaviorY: 'contain',
  overflowAnchor: 'none',
}}
```

Scroll position is tracked per thread:

- In memory: `threadScrollPositionsRef`, keyed by thread id.
- Persisted: `funny.threadScrollProgress.v1` in localStorage.

The saved value is a progress ratio, not a pixel offset. When a thread is at the
bottom, progress is saved as `1`. A thread is considered bottom-pinned when its
distance from bottom is `<= 80px`.

On thread switch, `MessageStream`:

1. Resets pagination/anchor/sticky prompt refs for the new thread.
2. Loads the saved scroll progress.
3. If no saved position exists or the saved position is bottom-pinned, scrolls
   to the bottom.
4. Otherwise restores to `savedProgress * maxScrollTop`.
5. Reapplies the same restoration immediately and across two animation frames
   to survive late layout and measurement.

## Sticky bottom behavior

`userHasScrolledUp` decides whether incoming content should force the viewport
to the bottom.

- If the user is bottom-pinned and streamed content grows, the viewport is pinned
  to the new bottom.
- If the user has scrolled up, streamed content should not move the viewport.
- A new user message resets `userHasScrolledUp` and pins the viewport to bottom.
- A new waiting reason of `question` or `permission` smooth-scrolls to bottom
  because the user needs to act.
- The scroll-to-bottom button is shown only when there is overflow, the viewport
  is not at bottom, and the code is not already programmatically scrolling to
  bottom.

`pinViewportToBottom` writes `scrollTop = scrollHeight` immediately and again
across animation frames. This is intentional: virtual rows, markdown, tool
cards, and status tails can change height after the first commit.

## Pagination Over Loaded Windows

The store may load only a window of messages. `MessageStream` does not reserve
estimated visual space for unloaded history. The scrollbar represents real,
currently loaded content; older/newer pages are loaded incrementally when the
user reaches the loaded window's edges.

Inputs from pagination:

- `hasMore`: there are older messages before the loaded window.
- `hasMoreAfter`: there are newer messages after the loaded window.
- `loadingMore`: a page request is in flight.
- `total`: total message count for the thread.
- `windowStart`: number of messages before the loaded window.
- `load`: load older messages.
- `loadAfter`: load newer messages.

`total` and `windowStart` remain pagination metadata. They do not produce spacer
height in `MessageStream`.

### Loading older messages

On scroll, older messages load when all of these are true:

- `scrollTop < 200`.
- the current scroll event is upward, or `scrollTop <= 1`.
- `hasMore`.
- `!loadingMore`.
- `!messageListRef.current?.hasHiddenItems()`.

The `hasHiddenItems` guard is critical. Without it, reaching the top of the
viewport could load backend pages while there are still already-loaded virtual
rows above the mounted window.

Before calling `pagination.load()`, `MessageStream` asks the message list to
capture a scroll anchor. When the first loaded message id changes, it restores
that anchor so prepending rows does not move the user's reading position.

If `messageListRef` is not available, there is a fallback that adds the increase
in `scrollHeight` to `scrollTop`, but the normal path should be anchor based.

### Loading newer messages

Newer messages load when all of these are true:

- `pagination.loadAfter` exists.
- `hasMoreAfter`.
- `!loadingMore`.
- `scrollTop + clientHeight > scrollHeight - 200`.

Newer pages append after the loaded window. There is no explicit captured anchor
for this direction. Stability relies on normal sticky-bottom behavior and the
fact that appending below the current read position should not shift content
above.

## Store pagination contract

`loadOlderMessages` in `thread-store.ts`:

- Reads the active thread.
- Bails if there is no active thread, `hasMore` is false, or `loadingMore` is
  true.
- Uses the first loaded message timestamp as the cursor.
- Calls `api.getThreadMessages(threadId, oldestTimestamp, 50)`.
- Deduplicates returned messages by id.
- Prepends new messages.
- Updates `hasMore`, `hasMoreAfter`, `totalMessages`, `windowStart`, and
  `loadingMore`.
- If the API does not return `windowStart`, it subtracts the number of truly new
  messages from the previous `windowStart`.

`loadNewerMessages` is symmetrical:

- Uses the newest loaded message timestamp as the cursor.
- Calls `api.getThreadMessages(threadId, newestTimestamp, 50, 'after')`.
- Deduplicates by id.
- Appends new messages.
- Updates `hasMore`, `hasMoreAfter`, `totalMessages`, `windowStart`, and
  `loadingMore`.

Both methods bail after the request if the thread entry no longer exists. That
protects against thread switches while a page request is in flight.

## Memoization contract

`MemoizedMessageList` has a custom comparator. It intentionally ignores active
thread fields unrelated to row rendering so the heavy list does not re-render on
cost, context usage, and similar updates.

Fields that affect rendering must be included in the comparator. The comparator
currently treats `threadStatus` as a boolean transition into/out of `waiting`,
because interactive tool cards only need to know whether response buttons should
be available.

If a new prop changes row contents, row heights, row keys, sticky context, or
tool-card controls, update `messageListAreEqual`. Otherwise the UI may keep
showing stale rows even though parent state changed.

## Edge cases checklist

- Empty thread or no renderable rows: virtual row count can be zero; the stream
  still owns bottom pinning and footer layout.
- Empty assistant placeholder later receives content: messages must repaint;
  do not use content visibility on message rows.
- Variable-height tool output grows after mount: measurement must update via
  ResizeObserver and explicit remeasure calls.
- Font size or container width changes: height cache must clear and rows must be
  remeasured.
- Thread switch from long to short and back: restore per-thread progress, not a
  stale pixel offset.
- Saved non-bottom position with changed content height: restore by progress.
- User has scrolled up while streaming: do not auto-scroll.
- User sends a new message: reset to bottom.
- Waiting for permission/question: bring the prompt/status area into view.
- Top pagination while first loaded rows are virtualized away: do not call
  `load` until `hasHiddenItems()` is false.
- Prepending older rows: capture anchor before load and restore after the first
  loaded id changes.
- Anchor row no longer exists: clear anchor instead of applying stale drift.
- Anchor row exists but is not mounted: scroll to its index, then apply drift.
- Bottom pagination: appends should not move the current read position; if the
  user is bottom-pinned, sticky-bottom logic should keep them at the bottom.
- `windowStart`, `totalMessages`, or `hasMoreAfter` are wrong: server-side
  window metadata is wrong and navigation/search may request the wrong pages.
- Deduped page response: `windowStart` must account for only truly new messages,
  not all returned rows.
- Tool-call grouping: scrolling to any tool id in a group may land on the same
  virtual row.
- Session summaries add rows that do not correspond to messages.
- Sticky section context duplicates a user message card; tests and queries must
  avoid counting it as a real measured row.
- Browser scroll anchoring must remain disabled on the viewport and virtual
  container.
- `listScrollMargin` depends on DOM structure above the virtual list; changing
  wrappers can break row placement.

## Debugging steps

1. Identify which layer is wrong: DOM virtualization, data-window pagination, or
   sticky-bottom restoration.
2. Inspect `activeThread.messages.length`, `totalMessages`, `windowStart`,
   `hasMore`, and `hasMoreAfter`.
3. Check whether mounted rows have stable `data-virtual-row-key` values and
   whether `data-index` matches the expected virtual row.
4. Compare `rowVirtualizer.getTotalSize()` with visible container height.
5. Verify `listScrollMargin` if rows are translated too high or too low.
6. For prepend jumps, verify `captureScrollAnchor` runs before the page load and
   `restoreScrollAnchor` runs after the first loaded message id changes.
7. For streaming jumps, inspect `userHasScrolledUp`,
   `scrollingToBottomRef`, and the previous sticky metrics.
8. For missing content, check whether the message was skipped by
   `buildGroupedRenderItems` because content is empty or represented by a tool
   card.
9. For stale controls or rows, check `messageListAreEqual` before blaming the
   virtualizer.

## Existing tests to run when changing this area

Targeted tests:

```bash
bun run --cwd packages/client test -- MemoizedMessageList
bun run --cwd packages/client test -- MessageStream
```

Repository verification required by this repo:

```bash
bun run lint
bun run typecheck
```

Add or update tests when changing row derivation, measurement, pagination
triggers, anchor restoration, sticky-bottom behavior, or the custom memo
comparator.
