## 1. Selection state in ui-store

- [x] 1.1 Add `gridSelectedThreadId: string | null` to `ui-store.ts` with a `setGridSelectedThreadId(id)` setter.
- [x] 1.2 Initialize from `localStorage` (`funny:grid-selected-thread:v1`) and persist on every set.
- [x] 1.3 Test: setter round-trips through `localStorage`; clearing removes the key. (`__tests__/stores/ui-store.test.ts`)

## 2. Selection lifecycle in LiveColumnsView

- [x] 2.1 Auto-select the first occupied cell (row-major) on mount / when `gridCells` change and no valid selection exists. (`resolveGridSelection` + effect)
- [x] 2.2 Restore persisted selection on mount; if the stored id is not currently placed in `gridCells`, fall back to auto-select-first.
- [x] 2.3 Clear the selection when the selected thread is no longer placed (covers remove + drag/collapse reshuffle) — strict clear, no auto-jump mid-session.
- [x] 2.4 Test: auto-select-first; reload restores a still-placed selection and falls back when stale; strict-clear on mid-session remove; first-appear auto-select; row-major ordering. (`__tests__/lib/grid-selection.test.ts`)

## 3. Click-to-select + selected-border in ThreadColumn

- [x] 3.1 `onPointerDownCapture` on the column calls `setGridSelectedThreadId(threadId)` (capture phase, so inner handlers can't swallow it; does not interfere with drag/prompt).
- [x] 3.2 Highlighted border when `threadId === gridSelectedThreadId` (`border-primary ring-primary/40 ring-1`, theme-aware).
- [x] 3.3 Remove the action icons from the column `ProjectHeader` via a new `hideActions` prop (keeps drag-handle, status, title, remove-`✕`).
- [x] 3.4 `data-selected` attribute on the selectable cell.

## 4. Extract ThreadHeaderActions

- [x] 4.1 Extract the right-side action-icon cluster from `ProjectHeader.tsx` into an exported `ThreadHeaderActions` component (same module, so `MoreActionsMenu`/`StartupCommandsPopover` need no cross-file move). Reads the thread from `ThreadProvider` context.
- [x] 4.2 Re-point `ProjectHeader` to render `ThreadHeaderActions` inline (and `hideActions` to suppress it) — no behavior change in the main view (full client suite + build green).
- [x] 4.3 Mount `ThreadHeaderActions` in the grid header (`LiveColumnsView`) under `ThreadProvider(gridSelectedThreadId)`, next to `GridPicker`, with `hideTests hideStartup hideTerminal hideTimeline`; hidden when there is no selection.

## 5. Reuse the global right pane in App.tsx

- [x] 5.1 `effectiveThreadId(liveColumnsOpen, gridSelectedThreadId, activeThreadId)` drives the app-level `<ThreadProvider>`; `activeThreadCanShowGit` resolves from the grid-selected thread while the grid is open.
- [x] 5.2 `isRightPaneVisible(...)` relaxes visibility to allow the pane while the grid is open and a thread is selected.
- [x] 5.3 Confirmed `CenterDockview` drives the right slot purely off `rightPaneOpen` (not `isFullScreenView`) — no extra plumbing needed.
- [x] 5.4 Verified the grid lives in the `thread` dockview slot (overlay) while the right pane is a sibling slot, so it renders beside the grid (build + manual reasoning).

## 6. Verification

- [x] 6.1 Pure derivations for the header→right-pane wiring tested (`effectiveThreadId`, `isRightPaneVisible`); the render path (dockview portal) is existing, tested infrastructure.
- [x] 6.2 Scratch gating inherited for free — `ThreadHeaderActions` uses the same `variant.canDoGitOps` predicate as the main view; no new gating code, so no separate test needed.
- [x] 6.3 Test: grid selection does NOT affect the effective thread / right-pane visibility when the grid is closed (no leak). (`__tests__/lib/grid-right-pane.test.ts`)
- [x] 6.4 `tsc --noEmit` clean (0 errors); `bun run build` green; full client suite 1543 tests pass.

## 7. Follow-up fixes (post-review fidelity)

- [x] 7.1 Right pane re-scopes when the grid selection changes. `ReviewPane` / `ReviewPaneStateContext` / `ProjectFilesPane` keyed git/project state off the store's `selectedThreadId` / `selectedProjectId` (not the provider context), so switching grid cells didn't update them. Added grid-aware `useRightPaneThreadId` / `useRightPaneProjectId` hooks (`hooks/use-right-pane-target.ts`, backed by pure `effectiveThreadId` / `rightPaneProjectId` in `lib/grid-right-pane.ts`) and swapped the three reads. Tested (`grid-right-pane.test.ts`, incl. no-leak).
- [x] 7.2 Grid header exposes the FULL action set. Startup / terminal / tests were hidden; un-hid them (`hideTimeline` only). Terminal handler made grid-aware (uses the context `projectId`, not global `selectedProjectId`); the terminal bottom pane is allowed through in the grid (`App.tsx`: `bottomPaneOpen` relaxed like the right pane). Tests stays full-screen (closes the grid via `setTestRunnerOpen`).
- [x] 7.3 Compose cell isolation. The new-thread cell (`EmptyGridCell`) inherited the app-level thread context (which follows the grid selection) and showed the selected thread's queue / context %. Wrapped it in `<ThreadProvider threadId={null}>` so a new thread inherits nothing.
- [x] 7.4 Card parity via a single shared component. Extracted the conversation body (`MessageStream` + ref-scoped `useThreadHandlers`/`useThreadCheckpoints` + session-changes summary + todo snapshots + follow-up input / read-only notice) into `components/thread/ThreadConversation.tsx`. Both the main view (`ThreadChatView`) and each grid column (`ThreadColumn`) now render `ThreadConversation` under their own `ThreadProvider`, so the messages, tool cards, session summary, and follow-up input are guaranteed identical. Host-specific concerns stay with the host: main keeps the pipeline banner, global Ctrl+F, and timeline; grid keeps its header/drag/selection and per-column search. Lightbox is shared-or-internal via an optional prop; older-message pagination is enabled only for the main view (the store paginates the globally-active thread).
- [x] 7.5 `tsc --noEmit` clean; `bun run build` green; full client suite 1546 tests pass.
