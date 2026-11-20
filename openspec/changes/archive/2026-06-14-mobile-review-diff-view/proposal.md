## Why

On mobile, the review flow is only half-adapted. The **file list** is already a
proper full-screen drill-down: `mobile/ChatView.tsx` renders the reused desktop
`ReviewPane` inside a `fixed inset-0 z-50` overlay with a back button
(`mobile-review-overlay`). But tapping a file inside that list opens
`review-pane/DiffViewerModal.tsx` — a **centered desktop `Dialog`** sized
`h-[85vh] max-w-[90vw]` with a fixed **280px file-tree sidebar** beside the diff.
On a phone that is the "giant popup": desktop chrome wedged onto a small screen,
with a sidebar that does not fit and a centered modal opened on top of an
already-full-screen overlay (a Radix `Dialog` nested inside `fixed inset-0`, which
fights scroll-lock and focus trapping).

The diff _rendering_ is not the problem — `ExpandedDiffView` already reflows to any
width. The problem is the **chrome** around it: `DiffViewerModal` is
`[ desktop chrome: centered Dialog + 280px sidebar ] + ExpandedDiffView`. On mobile
we want different chrome (full-screen, back button, no sidebar) around the **same
core**.

## What Changes

- **New mobile diff view as a second drill-down level.** Instead of opening the
  centered `DiffViewerModal`, on mobile tapping a file pushes a full-screen
  overlay that mirrors the existing `mobile-review-overlay` pattern: `fixed inset-0
  z-50 flex flex-col`, a back-button header, and `ExpandedDiffView` filling the
  body. Navigation becomes **list → diff → back**, with no nested Radix `Dialog`.
- **Drop the 280px file-tree sidebar on mobile.** It is redundant — the user just
  came from the file list, which is the previous screen. Removing it reclaims the
  whole width for the diff.
- **Read-only diff on mobile.** The mobile diff view renders `ExpandedDiffView`
  **without** `selectable` / `onStagePatch` / `selectAllSignal` / `deselectAllSignal`.
  Mobile is for reviewing; line selection, partial staging, and commit happen on
  desktop. This keeps the diff header minimal (back + filename + position + arrows).
- **Prev/next file navigation in the header.** Two header buttons (◀ ▶) step through
  the same `filteredDiffs` array that feeds the file list, so order matches what the
  user saw. The arrows disable at the first/last file. This preserves the
  file-to-file flow the desktop sidebar gave, without the sidebar.
- **Desktop is untouched.** `DiffViewerModal` keeps rendering exactly as today when
  `useIsMobile()` is false. The split is by presentation chrome only; the diff core
  (`ExpandedDiffView`) and all the data wiring in `ReviewPaneStateContext` are
  shared.

## Impact

- **Affected specs:** new `mobile-review` capability (mobile presentation of the
  per-file diff).
- **Affected code (client only):**
  - `packages/client/src/components/review-pane/` — new `MobileDiffView.tsx`
    (sibling to `DiffViewerModal.tsx`); the expanded-diff render site chooses
    between them via `useIsMobile()`.
  - `packages/client/src/components/review-pane/ReviewPaneStateContext.tsx` and/or
    `ReviewPane.tsx` — the two places that mount `DiffViewerModal` branch on
    `useIsMobile()`.
- **No server, DB, or shared-package changes.** Pure client presentation.
- **No behavior change on desktop.** The mobile path is gated entirely behind the
  `useIsMobile()` (`max-width: 768px`) breakpoint.
