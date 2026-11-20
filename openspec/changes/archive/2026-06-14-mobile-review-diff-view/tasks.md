## 1. Mobile diff view component

- [x] 1.1 Create `packages/client/src/components/review-pane/MobileDiffView.tsx`. Full-screen overlay mirroring the `mobile-review-overlay` pattern in `mobile/ChatView.tsx` (`fixed inset-0 z-[60] flex flex-col`, `h-14` header with back button, `min-h-0 flex-1 overflow-hidden` body). Open state is driven by `expandedFile != null`; back/close calls `onClose`.
- [x] 1.2 Define `MobileDiffViewProps` as the read-only subset of `DiffViewerModalProps`: keep `expandedFile`, `expandedSummary`, `expandedDiffContent`, `ExpandedIcon`, `onClose`, `onFileSelect`, `filteredDiffs`, `summaries`, `basePath`, `loadingDiff`, `diffCache`, `prThreads`, `requestFullDiff`, `handleResolveConflict`. Drop the staging/selection props (`selectable` usage, `handleStagePatch`, `patchStagingInProgress`, `handleSelectionStateChange`, `selectAllSignal`, `deselectAllSignal`) and the sidebar-search props (`fileSearch`, `setFileSearch`, `fileSearchCaseSensitive`, `setFileSearchCaseSensitive`, `checkedFiles`, `toggleFile`, `onRevertFile`, `onIgnore`).
- [x] 1.3 Render `ExpandedDiffView` in the body **without** the interactive props (no `selectable`, `onStagePatch`, `stagingInProgress`, `onSelectionStateChange`, `selectAllSignal`, `deselectAllSignal`). Pass the kept read props through as `DiffViewerModal` does today.
- [x] 1.4 Add `data-testid="mobile-diff-overlay"` on the root and `data-testid="mobile-diff-back"` on the back button. Header title shows the file name (`expandedSummary?.path`), truncated.

## 2. Prev/next file navigation

- [x] 2.1 Compute `currentIndex = filteredDiffs.findIndex(d => d.path === expandedFile)`. Render position label `"{currentIndex + 1}/{filteredDiffs.length}"` (hidden when `currentIndex < 0`).
- [x] 2.2 Add ◀ / ▶ buttons in the header. ◀ disabled when `currentIndex <= 0`; ▶ disabled when `currentIndex >= filteredDiffs.length - 1`. On tap, call `onFileSelect(filteredDiffs[currentIndex ∓ 1].path)`. `data-testid="mobile-diff-prev"` / `mobile-diff-next`.
- [x] 2.3 Use shadcn `Button` (icon/ghost variant) + lucide chevrons; respect theme + font-size tokens (no hardcoded px). Disabled arrows are visually muted and non-interactive.

## 3. Wire the mobile/desktop switch at the mount site

> **Resolved (was an open question):** the live mobile mount site is **`ReviewPane.tsx:300`**. Mobile renders `mobile/ChatView.tsx:219 → <ReviewPane />`, which holds its OWN `useReviewState()` instance (`ReviewPane.tsx:122`) and its OWN modal at line 300, driven by local `expandedFile`/`setExpandedFile`. Tapping a file in the mobile list calls that local `setExpandedFile`, so the modal that appears on mobile is `ReviewPane.tsx:300`. The second `DiffViewerModal` in `ReviewPaneStateContext.tsx:251` belongs to the parallel `panels/`-via-context architecture (desktop) — it is mounted in the tree but its context `setExpandedFile` is never called on the mobile path, so it does NOT fire on mobile.

- [x] 3.1 Create `review-pane/ExpandedDiffPresenter.tsx`: `useIsMobile() ? <MobileDiffView {...readProps} /> : <DiffViewerModal {...allProps} />`. Single switch, no duplicated branch logic.
- [x] 3.2 Replace the `<DiffViewerModal .../>` at **`ReviewPane.tsx:300`** with `<ExpandedDiffPresenter .../>` (this is the live mobile site — required).
- [x] 3.3 Replace the `<DiffViewerModal .../>` at `ReviewPaneStateContext.tsx:251` with `<ExpandedDiffPresenter .../>` too, so the desktop context architecture also gets the responsive switch (harmless on desktop, future-proofs if that path ever renders narrow). Confirm desktop still renders `DiffViewerModal` unchanged when `useIsMobile()` is false at both sites.

## 4. Tests

- [x] 4.1 Component test (mobile viewport / `useIsMobile` mocked true): tapping a file in the review list opens `mobile-diff-overlay` and **not** `expanded-diff-overlay` (the desktop Dialog). Asserts the regression — desktop modal must not appear on mobile.
- [x] 4.2 Prev/next test: with N files, ◀ disabled on first, ▶ disabled on last, and tapping ▶ calls `onFileSelect` with the next file's path; position label updates.
- [x] 4.3 Read-only test: `mobile-diff-overlay` renders no staging/select-all affordance (assert the staging testids from `ExpandedDiffView` are absent).
- [x] 4.4 Desktop guard test (`useIsMobile` false): still renders `expanded-diff-overlay`, `MobileDiffView` absent.

## 5. Verify

- [x] 5.1 `bun run build` (client builds clean) and type-check the touched files.
- [ ] 5.2 Manual smoke at `< 768px`: open review → tap file → full-screen diff, no centered popup, arrows step through files, back returns to the list with scroll preserved.
