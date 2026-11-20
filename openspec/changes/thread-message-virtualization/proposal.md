## Why

Long thread views currently avoid eager data loading, but they do not have true
DOM virtualization. Entering a thread loads only the newest message page
(`api.getThread(threadId, 50)`), and thread search runs server-side, but
`MemoizedMessageList` uses an append-only window:

1. The list initially mounts the newest grouped items.
2. Scrolling up or jumping to an old search result expands the mounted range
   from the bottom toward that target.
3. Once mounted, items are never unmounted; `content-visibility: auto` reduces
   paint cost but leaves DOM nodes, observers, React state, and measurements in
   memory.

This means a single search jump to a very old result can mount most of a long
conversation, and the mounted DOM stays large for the rest of the session. The
user-facing symptom is that a long thread "feels like it loads the whole
thread", especially after search/navigation or deep upward scrolling.

## What Changes

- Replace the append-only render window in
  `packages/client/src/components/thread/MemoizedMessageList.tsx` with true
  virtualization using `@tanstack/react-virtual`.
- Keep the public imperative handle used by `MessageStream` and thread search:
  `expandToItem`, `hasHiddenItems`, `captureScrollAnchor`, and
  `restoreScrollAnchor`.
- Preserve server-side search and lazy message pagination. Search still returns
  matches from the full history without loading all messages into the client;
  navigating to an unloaded result still asks the store to load older pages
  until the target message exists locally.
- Remove the append-only item spacer logic and use the virtualizer's total
  size/offset model for mounted grouped items.
- Keep the `MessageStream` phantom spacer only for messages that have not been
  loaded from the server yet, unless the implementation proves that total
  virtual counts can safely replace it.
- Add focused tests and manual verification for long threads, search jumps,
  streaming sticky-bottom behavior, pagination anchoring, and visible-message
  tracking.

## Capabilities

### New Capabilities

- `thread-message-virtualization`: true DOM virtualization for long thread
  message streams, preserving lazy loading, full-history search navigation, and
  scroll behavior while bounding mounted DOM size.

## Impact

- **`packages/client/src/components/thread/MemoizedMessageList.tsx`** - replace
  `renderCount`/`windowStart` append-only windowing with a tanstack virtualizer
  over `buildGroupedRenderItems(...)`; adapt rendering to absolute-positioned
  virtual rows; use `measureElement` and existing height estimation as
  `estimateSize`.
- **`packages/client/src/components/thread/MessageStream.tsx`** - adapt
  pagination/top-load checks to virtualizer hidden-range semantics; keep sticky
  bottom and phantom spacer behavior for unloaded server pages.
- **`packages/client/src/hooks/use-thread-search.ts`** - keep behavior but
  verify `expandToItem` now scrolls/virtualizes around the target instead of
  expanding all intermediate items.
- **`packages/client/src/lib/render-items.ts`** - no expected behavior change,
  but it remains the source of virtual row keys and grouped-item ordering.
- **Tests** - add unit tests for helper calculations where possible and
  integration/browser tests for DOM bounds and scroll/search behavior.
- **No server changes** - current `messageLimit`, `hasMore`, `total`, and
  `loadMessagesUntil` APIs remain sufficient.
