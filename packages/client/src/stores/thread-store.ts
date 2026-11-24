import type { Thread } from '@funny/shared';
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
  archiveThread as archiveThreadRow,
  deleteThread as deleteThreadRow,
  moveThreadStage,
  pinThread as pinThreadRow,
  renameThread as renameThreadRow,
  setThreadPermissionMode as setThreadPermissionModeRow,
  unarchiveThread as unarchiveThreadRow,
} from '@/data/threads/actions';
import {
  addScratchThread as addScratchThreadRow,
  dropProjectThreads as clearProjectThreadRows,
  loadMoreProjectThreads,
  loadProjectThreads,
  loadScratchThreads as loadScratchThreadRows,
  loadSharedThreads as loadSharedThreadRows,
  removeThreadLocally,
} from '@/data/threads/loaders';
import {
  listedProjectThreadIds,
  readThreadIndex,
  readThreadRow,
  subscribeProjectLists,
} from '@/data/threads/read';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

import { deriveToolLists, useSettingsStore } from './settings-store';
import { registerThreadStore } from './store-bridge';
import { createLiveThreadActions, dropLiveThreadRefs, forgetThread } from './thread-live-refs';
import { cleanupThreadActor, prefetchThreadData } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import {
  setBufferedInitInfo,
  getSelectingThreadId,
  rebuildThreadProjectIndex,
  setClearThreadSelection,
} from './thread-store-internals';
import { createMessagePageActions, refreshActiveThreadFlow } from './thread-store-messages';
import { createOptimisticMessageActions } from './thread-store-optimistic';
import { selectThreadFlow } from './thread-store-select';
import { createWorktreeSetupActions } from './thread-store-setup';
import { readActiveThreadView, readThreadView } from './thread-view';
import * as wsHandlers from './thread-ws-handlers';

// Re-export for external consumers
export {
  invalidateSelectThread,
  setAppNavigate,
  getSelectingThreadId,
  getUrlThreadId,
  setUrlThreadId,
} from './thread-store-internals';

// ── Types ────────────────────────────────────────────────────────

// The payload types live in `./thread-types.ts` (no edge back to this file);
// re-exported here for existing call sites.
export type {
  AgentInitInfo,
  AgentResultInfo,
  CompactionEvent,
  ThreadWithMessages,
} from './thread-types';

// `ThreadState` lives in `./thread-state.ts` so peer modules can reference
// the shape without importing this file (which imports them — would close a
// cycle). Re-exported here for back-compat with existing call sites.
export type { ThreadState } from './thread-state';
import type { ThreadState } from './thread-state';

// ── Store ────────────────────────────────────────────────────────

function isAgentActive(state: ThreadState, threadId: string): boolean {
  const status = readThreadRow(threadId)?.status;
  return status === 'running' || status === 'waiting';
}

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

  addScratchThread: (thread: Thread) => {
    addScratchThreadRow(thread);
  },

  loadSharedThreads: () => loadSharedThreadRows(),

  loadThreadsForProject: (projectId: string, includeArchived: boolean = false) =>
    loadProjectThreads(projectId, includeArchived),

  loadMoreThreads: (projectId: string, includeArchived: boolean = false) =>
    loadMoreProjectThreads(projectId, includeArchived),

  selectThread: (threadId) => selectThreadFlow(set, get, threadId),

  prefetchThread: (threadId: string) => {
    if (!threadId) return;
    if (get().activeThread?.id === threadId) return;
    if (getSelectingThreadId() === threadId) return;
    prefetchThreadData(threadId);
  },

  // Board writes are optimistic transactions on the threads collection: they
  // never revert on a stale list response and roll back (with a toast) on
  // failure. See data/threads/actions.ts.
  archiveThread: async (threadId) => {
    const result = await archiveThreadRow(threadId);
    if (result.isOk()) cleanupThreadActor(threadId);
  },

  unarchiveThread: async (threadId, _projectId, stage) => {
    await unarchiveThreadRow(threadId, stage);
  },

  renameThread: async (threadId, _projectId, title) => {
    await renameThreadRow(threadId, title);
  },

  pinThread: async (threadId, _projectId, pinned) => {
    await pinThreadRow(threadId, pinned);
  },

  updateThreadStage: async (threadId, _projectId, stage) => {
    const row = readThreadRow(threadId);
    // Moving a never-started thread into In Progress starts it. The send
    // promotes the thread on the runner (stage + reuses its draft), so no
    // separate stage PATCH — that alone would leave it idle forever.
    if (stage === 'in_progress' && row?.status === 'idle' && row.initialPrompt) {
      const { allowedTools, disallowedTools } = deriveToolLists(
        useSettingsStore.getState().toolPermissions,
      );
      const result = await api.sendMessage(threadId, row.initialPrompt, {
        provider: row.provider,
        model: row.model,
        permissionMode: row.permissionMode,
        allowedTools,
        disallowedTools,
      });
      if (result.isErr()) toastError(result.error, 'startIdleThread');
      return;
    }
    await moveThreadStage(threadId, stage);
  },

  updateThreadPermissionMode: async (threadId, permissionMode) => {
    const current = get();
    const active = readActiveThreadView(current);
    const previousMode =
      readThreadView(current, threadId)?.permissionMode ??
      readThreadRow(threadId)?.permissionMode ??
      (active?.id === threadId ? active.permissionMode : undefined);
    if (!previousMode || previousMode === permissionMode) return true;

    // The row write is an optimistic transaction (rolls back with a toast on
    // failure); the loaded payload is patched alongside it.
    const patchPayload = (mode: typeof permissionMode) =>
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (thread) => ({
          ...thread,
          permissionMode: mode,
        })),
      );

    patchPayload(permissionMode);
    const result = await setThreadPermissionModeRow(threadId, permissionMode);
    if (result.isErr()) {
      patchPayload(previousMode);
      return false;
    }
    return true;
  },

  // Deletes are optimistic: the row leaves every list at once and comes back
  // (with a toast) if the server refuses. Local payload/selection state is
  // dropped once the delete is confirmed.
  deleteThread: async (threadId, _projectId, options) => {
    const result = await deleteThreadRow(threadId, {
      stopFirst: isAgentActive(get(), threadId),
      deleteBranch: options?.deleteBranch,
    });
    if (result.isOk()) forgetThread(get, set, threadId);
    return result.isOk();
  },

  deleteScratchThread: async (threadId) => {
    const result = await deleteThreadRow(threadId, { stopFirst: isAgentActive(get(), threadId) });
    if (result.isOk()) forgetThread(get, set, threadId);
    return result.isOk();
  },

  handleShareRevoked: (threadId) => {
    removeThreadLocally(threadId);
    forgetThread(get, set, threadId);
  },

  handleThreadDeleted: (threadId) => {
    removeThreadLocally(threadId);
    forgetThread(get, set, threadId);
  },

  ...createOptimisticMessageActions(set, get),

  ...createMessagePageActions(set, get),

  refreshActiveThread: () => refreshActiveThreadFlow(set, get),

  refreshAllLoadedThreads: async () => {
    const lists = readThreadIndex();
    const projectIds = Object.keys(lists.threadIdsByProject);
    const refreshScratch = lists.scratchThreadIds.length > 0;
    const refreshShared = lists.sharedThreadIds.length > 0;

    // Refetch every loaded project list in parallel through the data layer.
    await Promise.all(projectIds.map((pid) => loadProjectThreads(pid)));

    await Promise.all([
      refreshScratch ? get().loadScratchThreads() : Promise.resolve(),
      refreshShared ? get().loadSharedThreads() : Promise.resolve(),
    ]);
    await get().refreshActiveThread();
  },

  clearProjectThreads: (projectId: string) => {
    set((state) => {
      const ids = listedProjectThreadIds(projectId);
      clearProjectThreadRows(projectId);
      let patch: Partial<ThreadState> = {};
      if (ids && ids.length) {
        // Drop any payload entries that belonged to the cleared project. Use a
        // working state so multiple deletions compose without losing earlier
        // map mutations.
        let working: ThreadState = { ...state, ...patch } as ThreadState;
        for (const id of ids) {
          dropLiveThreadRefs(id);
          const sub = mutations.clearThreadData(working, id);
          Object.assign(patch, sub);
          working = Object.assign({ ...working }, sub) as ThreadState;
        }
      }
      const active = state.activeThread;
      const clearSelection = active?.projectId === projectId;
      if (clearSelection) {
        return { ...patch, selectedThreadId: null, activeThread: null };
      }
      return patch;
    });
  },

  // Live-column anchors on the loaded payload (see thread-live-refs.ts).
  ...createLiveThreadActions(set, get),

  // ── WebSocket event handlers (delegated) ─────────────────────

  handleWSInit: (threadId, data) => {
    // Apply directly when the thread is hydrated (right pane OR live column).
    // Otherwise buffer so the next selectThread / register can pick it up.
    if (get().threadDataById[threadId]) {
      wsHandlers.handleWSInit(get, set, threadId, data);
    } else {
      setBufferedInitInfo(threadId, data);
    }
  },

  handleWSMessage: (threadId, data) => {
    wsHandlers.handleWSMessage(get, set, threadId, data);
  },

  handleWSToolCall: (threadId, data) => {
    wsHandlers.handleWSToolCall(get, set, threadId, data);
  },

  handleWSToolOutput: (threadId, data) => {
    wsHandlers.handleWSToolOutput(get, set, threadId, data);
  },

  handleWSStatus: (threadId, data) => {
    wsHandlers.handleWSStatus(get, set, threadId, data);
  },

  handleWSStageChanged: (threadId, data) => {
    wsHandlers.handleWSStageChanged(get, set, threadId, data);
  },

  handleWSError: (threadId, data) => {
    wsHandlers.handleWSError(get, set, threadId, data);
  },

  handleWSResult: (threadId, data) => {
    wsHandlers.handleWSResult(get, set, threadId, data);
  },

  handleWSQueueUpdate: (threadId, data) => {
    wsHandlers.handleWSQueueUpdate(get, set, threadId, data);
  },

  handleWSCompactBoundary: (threadId, data) => {
    wsHandlers.handleWSCompactBoundary(get, set, threadId, data);
  },

  handleWSContextUsage: (threadId, data) => {
    wsHandlers.handleWSContextUsage(threadId, data);
  },

  ...createWorktreeSetupActions(set, get),

  // ── Agent lifecycle actions ──────────────────────────────────

  sendMessage: async (threadId, content, options) => {
    const result = await api.sendMessage(
      threadId,
      content,
      options ? { model: options.model, permissionMode: options.permissionMode } : undefined,
      options?.images,
    );
    if (result.isErr()) return false;
    return true;
  },

  stopThread: async (threadId) => {
    await api.stopThread(threadId);
  },

  approveTool: async (threadId, toolName, approved, allowedTools, disallowedTools, options) => {
    const result = await api.approveTool(
      threadId,
      toolName,
      approved,
      allowedTools,
      disallowedTools,
      options,
    );
    return result.isOk();
  },

  searchThreadContent: async (query, projectId) => {
    const result = await api.searchThreadContent(query, projectId);
    return result.isOk() ? result.value : null;
  },
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
  const threadPatch: Record<string, unknown> = {
    threadDataById: { ...state.threadDataById, [at.id]: at },
  };
  if (!(state.selectedThreadId === at.id || selecting)) {
    threadPatch.selectedThreadId = at.id;
  }
  useThreadStore.setState(threadPatch);
});
