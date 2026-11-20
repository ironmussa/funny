# Design — mobile-review-diff-view

## Context

The expanded per-file diff is mounted in two places, both of which render the
desktop `DiffViewerModal`:

- `ReviewPane.tsx:300`
- `review-pane/ReviewPaneStateContext.tsx:251`

`DiffViewerModal` is a Radix `Dialog` (`DialogContent` `h-[85vh] max-w-[90vw]`) with
two columns: a `280px` `FileTree` sidebar and the `ExpandedDiffView` body. All of the
diff data (expanded file, diff content, cache, PR threads, callbacks) is computed by
the surrounding context and passed in as props — `DiffViewerModal` is presentation
only.

The mobile review list already lives in a hand-rolled full-screen overlay in
`mobile/ChatView.tsx` (lines 201–222), **not** a Radix Dialog:

```
fixed inset-0 z-50 flex flex-col
  header (h-14, border-b)  →  back button + title
  body (min-h-0 flex-1 overflow-hidden)  →  <ReviewPane />
```

This overlay is the template the mobile diff view should copy, so the two mobile
review levels feel like one drill-down stack instead of a modal-on-overlay.

## Goals / Non-Goals

**Goals**

- Replace the centered desktop Dialog with a full-screen overlay on mobile.
- Reuse `ExpandedDiffView` unchanged as the diff core.
- Preserve file-to-file navigation via prev/next arrows.

**Non-Goals**

- No staging / line selection / commit on mobile (read-only).
- No change to desktop behavior.
- No swipe gestures (rejected — collides with the diff's own horizontal scroll and
  adds gesture-handling code; arrows are explicit and cheap).
- No new route. The diff view is an in-place overlay layer, same as the list overlay,
  so the browser back/`reviewPaneOpen` model stays simple.

## Decision 1 — Sibling component, not a responsive branch inside `DiffViewerModal`

Create `review-pane/MobileDiffView.tsx` as a sibling to `DiffViewerModal.tsx`. The
mount site picks one:

```tsx
const isMobile = useIsMobile();
// ...
{
  isMobile ? <MobileDiffView {...sharedDiffProps} /> : <DiffViewerModal {...sharedDiffProps} />;
}
```

Rationale: the two layouts share almost no JSX (centered Dialog + sidebar vs.
full-screen overlay + arrow header). Folding both into one component with `isMobile`
conditionals throughout would entangle two unrelated layout trees. A sibling keeps
each readable. The **props contract is shared** — `MobileDiffView` accepts the same
data props `DiffViewerModal` already receives, minus the staging/selection props it
will not use.

```
        ┌──────────────────────────────┐
        │  ReviewPaneStateContext       │  ← owns all diff data + callbacks
        │  computes sharedDiffProps     │
        └───────────────┬──────────────┘
                        │  useIsMobile()
              ┌─────────┴──────────┐
              ▼                    ▼
      DiffViewerModal        MobileDiffView      ← chrome differs
       (Dialog + 280px        (fixed inset-0 +
        sidebar)               arrow header)
              │                    │
              └────────┬───────────┘
                       ▼
                ExpandedDiffView                 ← shared diff core (unchanged)
```

## Decision 2 — Read-only: which props are dropped

`MobileDiffView` mounts `ExpandedDiffView` **without** the interactive props:

- Dropped: `selectable`, `onStagePatch`, `stagingInProgress`, `onSelectionStateChange`,
  `selectAllSignal`, `deselectAllSignal`.
- Kept: `filePath`, `oldValue`, `newValue`, `icon`, `loading`, `rawDiff`, `files`,
  `diffCache`, `onClose`, `prReviewThreads`, `onRequestFullDiff`, `onResolveConflict`.

`onResolveConflict` is kept because conflict resolution is a read-time concern of the
diff renderer, not a staging action; if a future scope wants it strictly read-only
too, it can drop it then. Everything that mutates working-tree/stage state is gone.

`MobileDiffView`'s prop type is therefore a `Pick`/`Omit` over the existing
`DiffViewerModalProps` shape (minus the sidebar-only props it also won't need:
`fileSearch`, `setFileSearch`, `caseSensitive`, `filteredDiffs` is still needed for
prev/next — see Decision 3).

## Decision 3 — Prev/next navigation

The header renders the current file's position and two arrow buttons:

```
┌────────────────────────────────────────────┐
│ ◀back   <icon> A.ts        2/5      ◀  ▶    │
└────────────────────────────────────────────┘
```

- The ordered source is the **same `filteredDiffs: FileDiffSummary[]`** the file list
  renders, so prev/next order matches what the user just scrolled.
- `currentIndex = filteredDiffs.findIndex(d => d.path === expandedFile)`.
- ◀ disabled when `currentIndex <= 0`; ▶ disabled when
  `currentIndex >= filteredDiffs.length - 1`.
- Tapping an arrow calls the existing `onFileSelect(path)` (already a prop on
  `DiffViewerModal`, used by the desktop sidebar's `FileTree`) with the neighbor's
  path. This reuses the exact load path the sidebar uses — no new data wiring.
- Position label `"{currentIndex + 1}/{filteredDiffs.length}"`.

Edge cases:

- If `expandedFile` is not in `filteredDiffs` (e.g. an active file filter excludes it),
  `currentIndex === -1` → both arrows disabled, position hidden. Acceptable; the user
  can still read the open file and back out.
- Single file → both arrows disabled.

## Decision 4 — Overlay layering vs. the list overlay

The list overlay (`mobile-review-overlay`) is `z-50`. The diff overlay renders **at a
higher layer** so it visually sits on top, and `onClose` pops back to the list (which
is still mounted underneath, preserving its scroll position). Two clean options:

- (a) Diff overlay at `z-[60]`, list stays mounted at `z-50` underneath. Back from the
  diff just unmounts the diff layer.
- (b) Conditionally render only one overlay at a time.

Prefer **(a)** — keeping the list mounted preserves its scroll position and avoids a
re-fetch/re-render flash when backing out, matching the "drill-down stack" mental
model. The diff overlay is driven by the existing `expandedFile` state (non-null =
open), so no new store flag is required; `onClose` sets `expandedFile = null`, same as
the desktop modal's close.

## Risks / Trade-offs

- **No staging on mobile** is a deliberate scope cut. If users ask to stage from the
  phone later, `ExpandedDiffView` already supports it — re-enable the dropped props in
  `MobileDiffView` behind the same component. Low cost to revisit.
- **Two mount sites, one live on mobile (resolved).** `DiffViewerModal` is mounted in
  two parallel architectures: `ReviewPane.tsx:300` (the god-file, its own
  `useReviewState()` instance) and `ReviewPaneStateContext.tsx:251` (the newer
  `panels/`-via-context architecture, mounted globally from `App.tsx:328`). The mobile
  path is `mobile/ChatView.tsx:219 → <ReviewPane />`, so the file list the user taps is
  ReviewPane's own, wired to its **local** `setExpandedFile` → the modal that appears on
  mobile is **`ReviewPane.tsx:300`**. The context modal at `:251` is in the tree but its
  context `setExpandedFile` is never called on the mobile path, so it does not fire
  there. Use one `ExpandedDiffPresenter` wrapper (the `useIsMobile()` switch) at BOTH
  sites to avoid duplicated branch logic — `ReviewPane.tsx:300` is the required one;
  `:251` is updated too for consistency and is harmless on desktop.
- **Breakpoint coupling.** The switch is `useIsMobile()` (`< 768px`), the same hook the
  rest of the mobile shell uses, so the diff presentation flips in lockstep with the
  mobile layout. No new breakpoint introduced.

## Open Questions

- Should the back arrow in the diff header go to the **file list** (one level) or all
  the way out of review (two levels)? Design assumes **one level** (back to list),
  matching the drill-down model.
- Does `ExpandedDiffView` render acceptably with no horizontal room for the gutter on
  very narrow screens, or does it need a `compact` flag? To verify during
  implementation; out of scope to add a new prop unless the render breaks.
