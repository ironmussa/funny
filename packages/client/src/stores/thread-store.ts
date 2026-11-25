/**
 * Thread store — Zustand store for thread state management.
 * Delegates WebSocket handling to thread-ws-handlers, state machine transitions
 * to thread-machine-bridge, and module-level coordination to thread-store-internals.
 *
 * ## Render Stability Rules
 *
 * Every `set()` call creates a new `activeThread` object reference, which
 * causes ALL components using `useThreadStore(s => s.activeThread)` to
 * re-render — even if they only read `status` or `initInfo`. To avoid
 * cascading re-renders:
 *
 * 1. **Use granular selectors** — prefer the context-aware hooks from
 *    `thread-context.tsx` (`useThreadStatus()`, `useThreadCore()`, …) over
 *    subscribing to the full `activeThread` object.
 *
 * 2. **Use `useStableNavigate()`** — never list `navigate` from
 *    `useNavigate()` as a `useCallback` dependency. It changes on every
 *    route transition. Use `useStableNavigate()` from
 *    `hooks/use-stable-navigate.ts` instead.
 *
 * 3. **Always pass a custom comparator to `memo()`** when a component
 *    receives objects from this store (Thread, Project). The default
 *    `===` check always fails on store-created objects. Use
 *    `threadsVisuallyEqual()` from `lib/shallow-compare.ts`.
 *
 * 4. **Never use conditional callback props** —
 *    `onAction={disabled ? undefined : handler}` alternates between
 *    `undefined` and a function, breaking `memo()`. Instead pass the
 *    handler always and a boolean `disabled` prop.
 */
import { create } from 'zustand';

import {
  addScratchThread as addScratchThreadRow,
  loadMoreProjectThreads,
  loadProjectThreads,
  loadScratchThreads as loadScratchThreadRows,
  loadSharedThreads as loadSharedThreadRows,
} from '@/data/threads/loaders';
import { subscribeProjectLists } from '@/data/threads/read';

import { registerThreadStore } from './store-bridge';
import type { ThreadState } from './thread-state';
import { createBoardActions } from './thread-store-board';
import {
  getSelectingThreadId,
  rebuildThreadProjectIndex,
  setClearThreadSelection,
} from './thread-store-internals';
import { createLiveThreadActions } from './thread-store-live-refs';
import { createOptimisticActions } from './thread-store-optimistic';
import { createPagingActions } from './thread-store-paging';
import { createRefreshActions } from './thread-store-refresh';
import { createSelectActions } from './thread-store-select';
import { createAgentActions, createWSActions, createWorktreeSetupActions } from './thread-store-ws';

// Re-export for external consumers
export {
  invalidateSelectThread,
  setAppNavigate,
  getSelectingThreadId,
  getUrlThreadId,
  setUrlThreadId,
} from './thread-store-internals';

// ── Types ────────────────────────────────────────────────────────

// The payload types live in `./thread-types.ts` and `ThreadState` in
// `./thread-state.ts`, so peer modules can reference the shapes without
// importing this file (which imports them — would close a cycle).
// Re-exported here for back-compat with existing call sites.
export type { AgentInitInfo, CompactionEvent, ThreadWithMessages } from './thread-types';
export type { ThreadState } from './thread-state';

// ── Store ────────────────────────────────────────────────────────
//
// The actions are grouped by concern in the `thread-store-*.ts` modules;
// each takes the store's `set` / `get` and returns its slice of actions.
// Prefer `getActiveThread(state)` (thread-store-paging.ts) over reading
// `activeThread` in new code — it reads the source-of-truth map directly.

export const useThreadStore = create<ThreadState>((set, get) => ({
  selectedThreadId: null,
  threadDataById: {},
  activeThread: null,
  threadLoadFailedId: null,
  setupProgressByThread: {},

  // Thread lists load through the data layer (`src/data/threads`): rows and
  // list membership land in the threads collection and its list metadata.
  // Concurrent loads of the same list share one request.
  loadScratchThreads: () => loadScratchThreadRows(),
  addScratchThread: (thread) => {
    addScratchThreadRow(thread);
  },
  loadSharedThreads: () => loadSharedThreadRows(),
  loadThreadsForProject: (projectId: string, includeArchived: boolean = false) =>
    loadProjectThreads(projectId, includeArchived),
  loadMoreThreads: (projectId: string, includeArchived: boolean = false) =>
    loadMoreProjectThreads(projectId, includeArchived),

  ...createSelectActions(set, get),
  ...createBoardActions(set, get),
  ...createOptimisticActions(set, get),
  ...createPagingActions(set, get),
  ...createRefreshActions(set, get),
  ...createLiveThreadActions(set, get),
  ...createWSActions(set, get),
  ...createWorktreeSetupActions(set, get),
  ...createAgentActions(),
}));

// Register with the bridge so project-store can access thread state without a direct import
registerThreadStore(useThreadStore);
setClearThreadSelection(() => {
  useThreadStore.setState({ selectedThreadId: null, activeThread: null });
});

// ── Thread index subscriber ──────────────────────────────────
// Keep the threadId→projectId index in sync with the project lists. Runs
// synchronously after every list change in the data layer.
subscribeProjectLists(rebuildThreadProjectIndex);

// ── activeThread → threadDataById back-fill (legacy callers) ──────
//
// Production code writes both `threadDataById` and `activeThread` in the
// same `set()` (via `mutations.applyThreadDataPatch` / `setThreadData`),
// so this subscriber is a no-op in the real flow. It exists as a safety
// net for tests and any future caller that still does
// `setState({ activeThread: X })` directly — those would otherwise see WS
// handlers / optimistic actions silently drop their writes (the helpers
// bail when the thread isn't in the map). When drift is detected, mirror
// the active payload into `threadDataById` and align `selectedThreadId`.
useThreadStore.subscribe((state) => {
  const at = state.activeThread;
  if (!at) return;
  const mapEntry = state.threadDataById[at.id];
  if (mapEntry === at) return; // already aligned
  // Don't realign `selectedThreadId` while a `selectThread` is in flight. The
  // route-sync invariant guard (use-route-sync.ts) treats the URL as the source
  // of truth and drives selection; realigning here would yank `selectedThreadId`
  // back to a stale `activeThread`, and the guard would immediately re-select
  // the URL's thread — a ~50ms ping-pong that flickers the tab title and hammers
  // selectProject/fetchBranch. Mirror the payload into the map regardless (the
  // safety net), but leave selection to the in-flight selectThread.
  const selecting = getSelectingThreadId() !== null;
  const threadPatch: Partial<ThreadState> = {
    threadDataById: { ...state.threadDataById, [at.id]: at },
  };
  if (!(state.selectedThreadId === at.id || selecting)) {
    threadPatch.selectedThreadId = at.id;
  }
  useThreadStore.setState(threadPatch);
});
