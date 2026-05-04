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
 * 1. **Use granular selectors** — prefer `useActiveThreadStatus()`,
 *    `useActiveInitInfo()` from `thread-selectors.ts` over subscribing to
 *    the full `activeThread` object.
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

import type { Thread, MessageRole, WaitingReason } from '@funny/shared';
import { toast } from 'sonner';
import { create } from 'zustand';

import i18n from '@/i18n/config';
import { threadsApi } from '@/lib/api/threads';
import { loadContextUsage } from '@/lib/context-usage-storage';
import { metric } from '@/lib/telemetry';

import {
  expandProject,
  selectProject as bridgeSelectProject,
  getProjectPath,
  registerThreadStore,
} from './store-bridge';
import { transitionThreadStatus, cleanupThreadActor } from './thread-machine-bridge';
import { useThreadReadStore } from './thread-read-store';
import {
  nextSelectGeneration,
  getSelectGeneration,
  getBufferedInitInfo,
  setBufferedInitInfo,
  getAndClearWSBuffer,
  clearWSBuffer,
  getSelectingThreadId,
  setSelectingThreadId,
  rebuildThreadProjectIndex,
  invalidateSelectThread as _internalInvalidate,
  setCacheInvalidator,
  notifyThreadSelected,
} from './thread-store-internals';
import type {
  AgentInitInfo,
  AgentResultInfo,
  CompactionEvent,
  ContextUsage,
  ThreadState,
  ThreadWithMessages,
} from './thread-types';
import * as wsHandlers from './thread-ws-handlers';

export { setAppNavigate, getSelectingThreadId } from './thread-store-internals';
export type {
  AgentInitInfo,
  AgentResultInfo,
  CompactionEvent,
  ContextUsage,
  ThreadState,
  ThreadWithMessages,
} from './thread-types';

/**
 * Invalidate cached thread data so the next selectThread() refetches.
 * Wraps the internal generation bump and also clears the per-thread LRU cache.
 */
export function invalidateSelectThread(): void {
  _internalInvalidate();
  cacheClear();
}

/** Run `cb` when the browser is idle (or on next tick if requestIdleCallback is unavailable).
 *  Used to defer non-critical work — like extending the loaded message window —
 *  past the first paint so the user sees the most recent messages immediately. */
function scheduleIdle(cb: () => void): void {
  const ric = (globalThis as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (typeof ric === 'function') ric(cb, { timeout: 1000 });
  else setTimeout(cb, 0);
}

// ── Waiting reconstruction ───────────────────────────────────────

const PERMISSION_DENIAL_PATTERN =
  /permission|hasn't been granted|not in the allowed tools|hook error:.*approval|denied this tool|Blocked by hook|is a sensitive file/i;

/**
 * Walk a message list backwards looking for the trailing tool call that
 * indicates the agent is waiting on user input. Returns undefined when the
 * last tool call doesn't match a known waiting trigger.
 */
function reconstructWaitingFromMessages(
  messages: ThreadWithMessages['messages'],
):
  | { waitingReason: WaitingReason; pendingPermission?: { toolName: string; toolInput?: string } }
  | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tcs = messages[i].toolCalls;
    if (!tcs?.length) continue;
    const lastTC = tcs[tcs.length - 1];
    if (lastTC.name === 'AskUserQuestion') {
      return { waitingReason: 'question' };
    }
    if (lastTC.name === 'ExitPlanMode') {
      return { waitingReason: 'plan' };
    }
    if (lastTC.output && PERMISSION_DENIAL_PATTERN.test(lastTC.output)) {
      const ti = (lastTC as { input?: unknown }).input;
      const serializedInput =
        lastTC.name === 'Bash' &&
        ti &&
        typeof ti === 'object' &&
        typeof (ti as { command?: unknown }).command === 'string'
          ? ((ti as { command: string }).command as string)
          : ti
            ? (() => {
                try {
                  return JSON.stringify(ti);
                } catch {
                  return undefined;
                }
              })()
            : undefined;
      return {
        waitingReason: 'permission',
        pendingPermission: { toolName: lastTC.name, toolInput: serializedInput },
      };
    }
    return undefined;
  }
  return undefined;
}

// ── Buffer replay ────────────────────────────────────────────────

function flushWSBuffer(threadId: string, store: ThreadState) {
  const events = getAndClearWSBuffer(threadId);
  if (!events) return;
  for (const event of events) {
    switch (event.type) {
      case 'message':
        store.handleWSMessage(threadId, event.data);
        break;
      case 'tool_call':
        store.handleWSToolCall(threadId, event.data);
        break;
      case 'tool_output':
        store.handleWSToolOutput(threadId, event.data);
        break;
      case 'status':
        store.handleWSStatus(threadId, event.data);
        break;
      case 'error':
        store.handleWSError(threadId, event.data);
        break;
      case 'result':
        store.handleWSResult(threadId, event.data);
        break;
      case 'context_usage':
        store.handleWSContextUsage(threadId, event.data);
        break;
      case 'compact_boundary':
        store.handleWSCompactBoundary(threadId, event.data);
        break;
    }
  }
}

// ── Eager thread prefetch ─────────────────────────────────────────
// Parse the URL at module-load time. If we're on a thread route, start
// fetching thread data immediately — in parallel with auth bootstrap and
// project loading — instead of waiting for useRouteSync.
const _prefetchCache = new Map<
  string,
  {
    threadPromise: ReturnType<typeof threadsApi.getThread>;
    eventsPromise: ReturnType<typeof threadsApi.getThreadEvents>;
  }
>();
{
  const m = window.location.pathname.match(/\/projects\/[^/]+\/threads\/([^/]+)/);
  if (m) {
    const threadId = m[1];
    _prefetchCache.set(threadId, {
      threadPromise: threadsApi.getThread(threadId, 50),
      eventsPromise: threadsApi.getThreadEvents(threadId),
    });
  }
}

// ── Per-thread LRU cache ──────────────────────────────────────────
// Avoids refetching messages on rapid back-and-forth thread switches.
// Cache hit → set activeThread synchronously (no network); SWR refresh
// in background if the entry is older than SWR_AFTER_MS but still within TTL.
interface ThreadCacheEntry {
  thread: ThreadWithMessages;
  fetchedAt: number;
}
const THREAD_CACHE_MAX = 8;
const THREAD_CACHE_TTL_MS = 5 * 60_000;
const THREAD_CACHE_SWR_AFTER_MS = 30_000;
const _threadCache = new Map<string, ThreadCacheEntry>();

function cacheGet(id: string): ThreadCacheEntry | undefined {
  const entry = _threadCache.get(id);
  if (!entry) return undefined;
  // Bump LRU recency
  _threadCache.delete(id);
  _threadCache.set(id, entry);
  return entry;
}

function cachePut(id: string, thread: ThreadWithMessages): void {
  if (_threadCache.has(id)) _threadCache.delete(id);
  _threadCache.set(id, { thread, fetchedAt: Date.now() });
  while (_threadCache.size > THREAD_CACHE_MAX) {
    const oldest = _threadCache.keys().next().value;
    if (!oldest) break;
    _threadCache.delete(oldest);
  }
}

function cacheInvalidate(id: string): void {
  _threadCache.delete(id);
}

// Expose cache invalidation to WS handlers via the internals registry to avoid
// a direct value import cycle (thread-store ↔ thread-ws-handlers).
setCacheInvalidator(cacheInvalidate);

function cacheClear(): void {
  _threadCache.clear();
}

// ── Store ────────────────────────────────────────────────────────

// Abort controller for in-flight selectThread API requests.
// When a new thread is selected, the previous fetch is aborted immediately
// to avoid piling up stale network requests during rapid thread switching.
let _selectAbortController: AbortController | null = null;

const _threadLoadPromises = new Map<string, Promise<void>>();

export const useThreadStore = create<ThreadState>((set, get) => ({
  threadsByProject: {},
  threadTotalByProject: {},
  selectedThreadId: null,
  activeThread: null,
  setupProgressByThread: {},
  contextUsageByThread: {},
  queuedCountByThread: {},

  loadThreadsForProject: async (projectId: string) => {
    // Deduplicate concurrent loads for the same project
    const existing = _threadLoadPromises.get(projectId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await threadsApi.listThreads(projectId, false, 50);
        if (result.isOk()) {
          set((state) => ({
            threadsByProject: { ...state.threadsByProject, [projectId]: result.value.threads },
            threadTotalByProject: {
              ...state.threadTotalByProject,
              [projectId]: result.value.total,
            },
          }));
        }
      } finally {
        _threadLoadPromises.delete(projectId);
      }
    })();

    _threadLoadPromises.set(projectId, promise);
    return promise;
  },

  loadMoreThreads: async (projectId: string) => {
    const { threadsByProject } = get();
    const currentThreads = threadsByProject[projectId] ?? [];
    const offset = currentThreads.length;
    const result = await threadsApi.listThreads(projectId, false, 50, offset);
    if (result.isOk() && result.value.threads.length > 0) {
      set((state) => ({
        threadsByProject: {
          ...state.threadsByProject,
          [projectId]: [...(state.threadsByProject[projectId] ?? []), ...result.value.threads],
        },
        threadTotalByProject: { ...state.threadTotalByProject, [projectId]: result.value.total },
      }));
    }
  },

  selectThread: async (threadId) => {
    // Short-circuit when already deselected to avoid no-op state churn
    if (!threadId && !get().selectedThreadId && !get().activeThread) return;

    // Skip if already loading this exact thread (prevents StrictMode double-fire)
    if (threadId && threadId === getSelectingThreadId()) return;

    const selectStart = performance.now();

    // Abort any in-flight fetch from a previous selectThread call.
    // This prevents piling up stale network requests during rapid clicking.
    _selectAbortController?.abort();
    const abortController = new AbortController();
    _selectAbortController = abortController;

    const gen = nextSelectGeneration();
    setSelectingThreadId(threadId);
    // Keep stale activeThread visible during load to avoid layout shift.
    // Only clear it if switching to null (deselect) or to a different thread.
    const prevActive = get().activeThread;
    const keepStale = threadId && prevActive && prevActive.id !== threadId;
    set({
      selectedThreadId: threadId,
      activeThread: keepStale ? prevActive : threadId ? prevActive : null,
    });
    // ui-store registers a listener via setThreadSelectListener to reset
    // its UI state when a thread is selected — keeps the dependency one-way.
    notifyThreadSelected();

    if (!threadId) {
      _selectAbortController = null;
      setSelectingThreadId(null);
      return;
    }

    // ── Cache hit fast path ───────────────────────────────────────
    // Reuse the last activeThread snapshot for this thread when available.
    // Avoids the network round trip on rapid back-and-forth switches.
    const cached = cacheGet(threadId);
    if (cached && Date.now() - cached.fetchedAt < THREAD_CACHE_TTL_MS) {
      const stored = cached.thread;
      // Re-merge per-thread state slices (these live outside the cached snapshot)
      const storedSetupProgress =
        stored.status === 'setting_up' ? get().setupProgressByThread[threadId] : undefined;
      const storedContextUsage = get().contextUsageByThread[threadId] ?? loadContextUsage(threadId);
      const storedQueuedCount = get().queuedCountByThread[threadId];
      set({
        activeThread: {
          ...stored,
          setupProgress: storedSetupProgress ?? stored.setupProgress,
          contextUsage: storedContextUsage ?? stored.contextUsage,
          queuedCount: storedQueuedCount ?? stored.queuedCount,
        },
      });
      useThreadReadStore.getState().markRead(threadId, stored.completedAt);
      bridgeSelectProject(stored.projectId);
      flushWSBuffer(threadId, get());
      metric('thread.select.duration', Math.round(performance.now() - selectStart), {
        attributes: { cacheHit: 'true' },
      });
      // Stale-while-revalidate: kick off background refresh if entry is aging.
      const isStale = Date.now() - cached.fetchedAt > THREAD_CACHE_SWR_AFTER_MS;
      if (isStale) {
        // Fire-and-forget; the existing fetch path below will write through.
        // Drop down to the network path but skip the keepStale visual bridge.
      } else {
        if (getSelectingThreadId() === threadId) setSelectingThreadId(null);
        if (_selectAbortController === abortController) _selectAbortController = null;
        return;
      }
    }

    try {
      // Use prefetched data if available (fired at module load time), otherwise fetch now.
      // Progressive paint: don't wait on /events to render — `getThread` carries
      // messages (the critical render dep); `getThreadEvents` is patched in
      // when it resolves so the activeThread becomes visible ~1 RTT sooner.
      const prefetched = _prefetchCache.get(threadId);
      _prefetchCache.delete(threadId);
      const threadPromise =
        prefetched?.threadPromise ?? threadsApi.getThread(threadId, 50, abortController.signal);
      const eventsPromise =
        prefetched?.eventsPromise ?? threadsApi.getThreadEvents(threadId, abortController.signal);

      const result = await threadPromise;

      if (result.isErr()) {
        // If aborted (superseded by a newer selectThread), silently bail out
        if (abortController.signal.aborted) return;
        if (getSelectGeneration() === gen) {
          clearWSBuffer(threadId);
          set({ selectedThreadId: null, activeThread: null });
        }
        return;
      }

      const thread = result.value;

      if (getSelectGeneration() !== gen) {
        clearWSBuffer(threadId);
        return;
      }

      const projectId = thread.projectId;

      // Ensure project is expanded and threads are loaded
      expandProject(projectId);
      if (!get().threadsByProject[projectId]) {
        get().loadThreadsForProject(projectId);
      }

      const buffered = getBufferedInitInfo(threadId);
      const resultInfo =
        thread.status === 'completed' || thread.status === 'failed'
          ? {
              status: thread.status as 'completed' | 'failed',
              cost: thread.cost,
              duration:
                thread.completedAt && thread.createdAt
                  ? Math.max(
                      0,
                      new Date(thread.completedAt).getTime() - new Date(thread.createdAt).getTime(),
                    )
                  : 0,
              error: (thread as any).error,
            }
          : undefined;

      // Derive waitingReason / pendingPermission from the last tool call so a
      // refreshed page can re-render the approval card. Reconstruct also for
      // 'running' threads — sometimes the persisted status lags behind the
      // last tool result (e.g. when the SDK denied a sensitive path and the
      // agent gracefully exited but the WAIT row commit hadn't landed yet).
      let waitingReason: WaitingReason | undefined;
      let pendingPermission: { toolName: string; toolInput?: string } | undefined;
      const isTerminalStatus =
        thread.status === 'completed' ||
        thread.status === 'failed' ||
        thread.status === 'stopped' ||
        thread.status === 'interrupted';
      if (!isTerminalStatus && thread.messages?.length) {
        const reconstructed = reconstructWaitingFromMessages(thread.messages);
        if (reconstructed) {
          waitingReason = reconstructed.waitingReason;
          pendingPermission = reconstructed.pendingPermission;
        }
      }

      // Merge stored setup progress for setting_up threads
      const storedSetupProgress =
        thread.status === 'setting_up' ? get().setupProgressByThread[threadId] : undefined;

      // Restore cached context usage so the bar survives thread switches and reloads
      const storedContextUsage = get().contextUsageByThread[threadId] ?? loadContextUsage(threadId);

      // Restore cached queued count so the queue widget survives thread switches
      const storedQueuedCount = get().queuedCountByThread[threadId];

      set({
        activeThread: {
          ...thread,
          hasMore: thread.hasMore ?? false,
          threadEvents: [],
          initInfo: thread.initInfo || buffered || undefined,
          resultInfo,
          waitingReason,
          pendingPermission,
          setupProgress: storedSetupProgress,
          contextUsage: storedContextUsage,
          queuedCount: storedQueuedCount ?? thread.queuedCount,
        },
      });
      useThreadReadStore.getState().markRead(threadId, thread.completedAt);
      bridgeSelectProject(projectId);

      // Replay any WS events that arrived while activeThread was loading
      flushWSBuffer(threadId, get());
      metric('thread.select.duration', Math.round(performance.now() - selectStart), {
        attributes: { cacheHit: 'false' },
      });

      // Patch threadEvents/compactionEvents in once /events resolves. Doesn't
      // block the first paint and survives a superseding selectThread (gen check).
      void eventsPromise.then((eventsResult) => {
        if (abortController.signal.aborted) return;
        if (getSelectGeneration() !== gen) return;
        const current = get().activeThread;
        if (!current || current.id !== threadId) return;
        const threadEvents = eventsResult.isOk() ? eventsResult.value.events : [];
        const compactionEvents: CompactionEvent[] = threadEvents
          .filter((e) => e.type === 'compact_boundary')
          .map((e) => {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            return {
              trigger: data.trigger ?? 'auto',
              preTokens: data.preTokens ?? 0,
              timestamp: data.timestamp ?? e.createdAt,
            };
          });
        set({
          activeThread: {
            ...current,
            threadEvents,
            compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
          },
        });
      });

      // If the initial window doesn't start on a user-message boundary, extend
      // it in idle time so the first paint isn't blocked by another fetch +
      // JSON parse round. The sticky section header reads from
      // `lastUserMessage` (sent in the initial response) until the older
      // batch lands.
      const seeded = get().activeThread;
      if (
        seeded?.id === threadId &&
        seeded.hasMore &&
        seeded.messages.length > 0 &&
        seeded.messages[0].role !== 'user'
      ) {
        scheduleIdle(() => {
          if (abortController.signal.aborted) return;
          if (getSelectGeneration() !== gen) return;
          const current = get().activeThread;
          if (!current || current.id !== threadId) return;
          void get().loadOlderMessages();
        });
      }
    } finally {
      // Clear in-flight tracker so future selectThread calls for this thread can proceed
      if (getSelectingThreadId() === threadId) {
        setSelectingThreadId(null);
      }
      // Clear abort controller if this is still the active one
      if (_selectAbortController === abortController) {
        _selectAbortController = null;
      }
    }
  },

  archiveThread: async (threadId, projectId) => {
    // Optimistic update: update UI immediately
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) => (t.id === threadId ? { ...t, archived: true } : t)),
      },
      activeThread:
        activeThread?.id === threadId ? { ...activeThread, archived: true } : activeThread,
    });

    // Make API call in background
    const result = await threadsApi.archiveThread(threadId, true);
    if (result.isErr()) {
      // Revert on error
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, archived: false } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, archived: false }
            : currentState.activeThread,
      });
      return;
    }
    cleanupThreadActor(threadId);
  },

  unarchiveThread: async (threadId, projectId, stage) => {
    // Optimistic update: update UI immediately
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    const oldThread = projectThreads.find((t) => t.id === threadId);
    const oldStage = oldThread?.stage ?? 'backlog';

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, archived: false, stage } : t,
        ),
      },
      activeThread:
        activeThread?.id === threadId ? { ...activeThread, archived: false, stage } : activeThread,
    });

    // Make API calls in background
    const archiveResult = await threadsApi.archiveThread(threadId, false);
    if (archiveResult.isErr()) {
      // Revert on error
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, archived: true, stage: oldStage } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, archived: true, stage: oldStage }
            : currentState.activeThread,
      });
      return;
    }

    const stageResult = await threadsApi.updateThreadStage(threadId, stage);
    if (stageResult.isErr()) {
      // If stage update fails, keep unarchived but revert stage
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, stage: oldStage } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, stage: oldStage }
            : currentState.activeThread,
      });
    }
  },

  renameThread: async (threadId, projectId, title) => {
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    const oldThread = projectThreads.find((t) => t.id === threadId);
    const oldTitle = oldThread?.title ?? '';

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) => (t.id === threadId ? { ...t, title } : t)),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, title } : activeThread,
    });

    const result = await threadsApi.renameThread(threadId, title);
    if (result.isErr()) {
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, title: oldTitle } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, title: oldTitle }
            : currentState.activeThread,
      });
    }
  },

  pinThread: async (threadId, projectId, pinned) => {
    // Optimistic update: update UI immediately
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    const oldThread = projectThreads.find((t) => t.id === threadId);
    const oldPinned = oldThread?.pinned;

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) => (t.id === threadId ? { ...t, pinned } : t)),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, pinned } : activeThread,
    });

    // Make API call in background
    const result = await threadsApi.pinThread(threadId, pinned);
    if (result.isErr()) {
      // Revert on error
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, pinned: oldPinned } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, pinned: oldPinned }
            : currentState.activeThread,
      });
      toast.error(i18n.t(pinned ? 'sidebar.pinFailed' : 'sidebar.unpinFailed'));
      return;
    }
    toast.success(i18n.t(pinned ? 'sidebar.threadPinned' : 'sidebar.threadUnpinned'));
  },

  updateThreadStage: async (threadId, projectId, stage) => {
    // Optimistic update: update UI immediately
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    const oldThread = projectThreads.find((t) => t.id === threadId);
    const oldStage = oldThread?.stage ?? 'backlog';

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) => (t.id === threadId ? { ...t, stage } : t)),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, stage } : activeThread,
    });

    // Make API call in background
    const result = await threadsApi.updateThreadStage(threadId, stage);
    if (result.isErr()) {
      // Revert on error
      const currentState = get();
      const currentProjectThreads = currentState.threadsByProject[projectId] ?? [];
      set({
        threadsByProject: {
          ...currentState.threadsByProject,
          [projectId]: currentProjectThreads.map((t) =>
            t.id === threadId ? { ...t, stage: oldStage } : t,
          ),
        },
        activeThread:
          currentState.activeThread?.id === threadId
            ? { ...currentState.activeThread, stage: oldStage }
            : currentState.activeThread,
      });
    }
  },

  deleteThread: async (threadId, projectId) => {
    // If the thread is still running, stop the agent first so it doesn't
    // keep executing in the background after we remove it from the UI.
    const { threadsByProject, selectedThreadId } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    const thread = projectThreads.find((t) => t.id === threadId);
    if (thread && (thread.status === 'running' || thread.status === 'waiting')) {
      await threadsApi.stopThread(threadId);
    }
    // Optimistic: update UI immediately, then fire API in background
    cleanupThreadActor(threadId);
    cacheInvalidate(threadId);
    set({
      threadsByProject: {
        ...get().threadsByProject,
        [projectId]: (get().threadsByProject[projectId] ?? []).filter((t) => t.id !== threadId),
      },
    });
    if (selectedThreadId === threadId) {
      set({ selectedThreadId: null, activeThread: null });
    }
    // Fire-and-forget: server cleanup (worktree removal, etc.) runs in background
    threadsApi.deleteThread(threadId);
  },

  appendOptimisticMessage: (threadId, content, images, model, permissionMode, fileReferences) => {
    const { activeThread, threadsByProject } = get();
    if (activeThread?.id === threadId) {
      const pid = activeThread.projectId;
      const projectThreads = threadsByProject[pid] ?? [];

      const machineEvent = { type: 'START' as const };
      const newStatus = transitionThreadStatus(
        threadId,
        machineEvent,
        activeThread.status,
        activeThread.cost,
      );

      // Pre-populate initInfo so the card renders immediately instead of
      // waiting for the agent:init WebSocket event from the server.
      const initInfo =
        activeThread.initInfo ??
        (() => {
          const projectPath = getProjectPath(pid);
          const cwd = activeThread.worktreePath || projectPath || '';
          return { model: model || activeThread.model, cwd, tools: [] as string[] };
        })();

      // Build a minimal <referenced-files> XML header so chips render in the message
      let messageContent = content;
      if (fileReferences && fileReferences.length > 0) {
        const tags = fileReferences
          .map((ref) =>
            ref.type === 'folder'
              ? `<folder path="${ref.path}"></folder>`
              : `<file path="${ref.path}" />`,
          )
          .join('\n');
        messageContent = `<referenced-files>\n${tags}\n</referenced-files>\n${content}`;
      }

      const newMessage = {
        id: crypto.randomUUID(),
        threadId,
        role: 'user' as MessageRole,
        content: messageContent,
        images,
        timestamp: new Date().toISOString(),
        model,
        permissionMode,
      };

      // For idle threads (backlog/planning), a draft user message already exists —
      // replace it instead of appending a duplicate.
      const existingDraftIdx =
        activeThread.status === 'idle'
          ? activeThread.messages.findIndex((m) => m.role === 'user')
          : -1;
      const nextMessages =
        existingDraftIdx >= 0
          ? activeThread.messages.map((m, i) => (i === existingDraftIdx ? newMessage : m))
          : activeThread.messages.concat(newMessage);

      // Only rebuild threadsByProject if the status actually changed
      const statusChanged = newStatus !== activeThread.status;
      const nextThreadsByProject = statusChanged
        ? {
            ...threadsByProject,
            [pid]: projectThreads.map((t) => (t.id === threadId ? { ...t, status: newStatus } : t)),
          }
        : threadsByProject;

      set({
        activeThread: {
          ...activeThread,
          initInfo,
          status: newStatus,
          // Clear initialPrompt so PromptInput doesn't restore it after send
          initialPrompt: undefined,
          waitingReason: undefined,
          pendingPermission: undefined,
          permissionMode: permissionMode || activeThread.permissionMode,
          messages: nextMessages,
          lastUserMessage: newMessage,
        },
        threadsByProject: nextThreadsByProject,
      });
    }
  },

  rollbackOptimisticMessage: (threadId) => {
    const { activeThread } = get();
    if (activeThread?.id !== threadId) return;

    // Remove the last user message (the optimistic one we just added)
    let lastUserIdx = -1;
    for (let i = activeThread.messages.length - 1; i >= 0; i--) {
      if (activeThread.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;

    const nextMessages = activeThread.messages.filter((_, i) => i !== lastUserIdx);
    // Restore lastUserMessage to the previous user message after rollback
    const prevUserMsg = [...nextMessages].reverse().find((m) => m.role === 'user');
    set({
      activeThread: {
        ...activeThread,
        messages: nextMessages,
        lastUserMessage: prevUserMsg ?? activeThread.lastUserMessage,
      },
    });
  },

  loadOlderMessages: async () => {
    const { activeThread } = get();
    if (!activeThread || !activeThread.hasMore || activeThread.loadingMore) return;

    const oldestMessage = activeThread.messages[0];
    if (!oldestMessage) return;

    // Older messages are about to merge in — drop the snapshot so the next
    // selectThread refetches the unified window instead of the cached tail.
    cacheInvalidate(activeThread.id);
    set({ activeThread: { ...activeThread, loadingMore: true } });

    // Keep paginating until the oldest loaded message is a user message OR
    // the server says there's nothing older. Sections are anchored on user
    // messages, and the sticky section header reads from the topmost loaded
    // user item — so every loaded window must end on a section boundary,
    // otherwise scrolling near the top shows assistant/tool content with no
    // sticky owner.
    const MAX_BATCHES = 10;
    let cursor = oldestMessage.timestamp;
    let aggregated: typeof activeThread.messages = [];
    let hasMoreFlag: boolean = activeThread.hasMore;

    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await threadsApi.getThreadMessages(activeThread.id, cursor, 50);

      const inflight = get().activeThread;
      if (!inflight || inflight.id !== activeThread.id) return;

      if (result.isErr()) {
        set({ activeThread: { ...inflight, loadingMore: false } });
        return;
      }

      const { messages: olderMessages, hasMore } = result.value;
      hasMoreFlag = hasMore;
      if (olderMessages.length === 0) break;

      aggregated = [...olderMessages, ...aggregated];

      if (aggregated[0].role === 'user' || !hasMore) break;
      cursor = olderMessages[0].timestamp;
    }

    const current = get().activeThread;
    if (!current || current.id !== activeThread.id) return;

    const existingIds = new Set(current.messages.map((m) => m.id));
    const newMessages = aggregated.filter((m) => !existingIds.has(m.id));

    set({
      activeThread: {
        ...current,
        messages: [...newMessages, ...current.messages],
        hasMore: hasMoreFlag,
        loadingMore: false,
      },
    });
  },

  refreshActiveThread: async () => {
    const { activeThread } = get();
    if (!activeThread) return;
    const [result, eventsResult] = await Promise.all([
      threadsApi.getThread(activeThread.id, 50),
      threadsApi.getThreadEvents(activeThread.id),
    ]);
    if (result.isErr()) return; // silently ignore
    const thread = result.value;
    const resultInfo =
      activeThread.resultInfo ??
      (thread.status === 'completed' || thread.status === 'failed'
        ? {
            status: thread.status as 'completed' | 'failed',
            cost: thread.cost,
            duration:
              thread.completedAt && thread.createdAt
                ? Math.max(
                    0,
                    new Date(thread.completedAt).getTime() - new Date(thread.createdAt).getTime(),
                  )
                : 0,
            error: (thread as any).error,
          }
        : undefined);
    const threadEvents = eventsResult.isOk()
      ? eventsResult.value.events
      : activeThread.threadEvents;

    // Reconstruct compactionEvents from persisted thread events
    const persistedCompaction: CompactionEvent[] = (threadEvents ?? [])
      .filter((e) => e.type === 'compact_boundary')
      .map((e) => {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        return {
          trigger: data.trigger ?? 'auto',
          preTokens: data.preTokens ?? 0,
          timestamp: data.timestamp ?? e.createdAt,
        };
      });
    // Only clear pendingPermission when the server reports a terminal status
    // (completed/failed/stopped/interrupted). Tab-switch can race with persisted
    // status (e.g. server is still 'running' while WS already pushed waiting),
    // and clobbering the WS-derived approval card on every refresh would make
    // it disappear. Reconstruct from messages when local state has nothing yet.
    const isTerminal =
      thread.status === 'completed' ||
      thread.status === 'failed' ||
      thread.status === 'stopped' ||
      thread.status === 'interrupted';

    let nextWaitingReason = isTerminal ? undefined : activeThread.waitingReason;
    let nextPendingPermission = isTerminal ? undefined : activeThread.pendingPermission;

    if (!isTerminal && !nextPendingPermission && activeThread.messages?.length) {
      const reconstructed = reconstructWaitingFromMessages(activeThread.messages);
      if (reconstructed) {
        nextWaitingReason = reconstructed.waitingReason;
        nextPendingPermission = reconstructed.pendingPermission;
      }
    }

    set({
      activeThread: {
        ...activeThread,
        // Update only metadata from server, preserve existing messages and pagination state
        status: thread.status,
        cost: thread.cost,
        stage: thread.stage,
        completedAt: thread.completedAt,
        archived: thread.archived,
        pinned: thread.pinned,
        mode: thread.mode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        baseBranch: thread.baseBranch,
        initInfo: activeThread.initInfo,
        resultInfo,
        threadEvents,
        compactionEvents:
          persistedCompaction.length > 0 ? persistedCompaction : activeThread.compactionEvents,
        contextUsage: activeThread.contextUsage,
        waitingReason: nextWaitingReason,
        pendingPermission: nextPendingPermission,
      },
    });
  },

  refreshAllLoadedThreads: async () => {
    const { threadsByProject, refreshActiveThread } = get();
    const projectIds = Object.keys(threadsByProject);

    // Fetch all projects in parallel, then batch into a single state update
    // instead of N separate set() calls (one per project) to avoid cascading
    // re-renders.
    const results = await Promise.all(
      projectIds.map(async (pid) => {
        const result = await threadsApi.listThreads(pid, false, 50);
        return {
          pid,
          threads: result.isOk() ? result.value.threads : null,
          total: result.isOk() ? result.value.total : 0,
        };
      }),
    );

    const prev = get().threadsByProject;
    const prevTotals = get().threadTotalByProject;
    let changed = false;
    const next: Record<string, Thread[]> = { ...prev };
    const nextTotals: Record<string, number> = { ...prevTotals };
    for (const { pid, threads, total } of results) {
      if (threads && threads !== prev[pid]) {
        next[pid] = threads;
        nextTotals[pid] = total;
        changed = true;
      }
    }
    if (changed) set({ threadsByProject: next, threadTotalByProject: nextTotals });

    await refreshActiveThread();
  },

  clearProjectThreads: (projectId: string) => {
    const { threadsByProject, activeThread } = get();
    const nextThreads = { ...threadsByProject };
    delete nextThreads[projectId];
    const clearSelection = activeThread?.projectId === projectId;
    set({
      threadsByProject: nextThreads,
      ...(clearSelection ? { selectedThreadId: null, activeThread: null } : {}),
    });
  },

  // ── WebSocket event handlers (delegated) ─────────────────────

  handleWSInit: (threadId, data) => {
    const { activeThread } = get();
    if (activeThread?.id === threadId) {
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
    wsHandlers.handleWSContextUsage(get, set, threadId, data);
  },

  handleWSWorktreeSetup: (threadId, data) => {
    const { activeThread, setupProgressByThread } = get();
    const now = Date.now();
    const prev = setupProgressByThread[threadId] ?? [];
    const existing = prev.find((s) => s.id === data.step);

    // Build step with timestamps that survive component remounts
    const step: import('@/components/GitProgressModal').GitProgressStep = {
      id: data.step,
      label: data.label,
      status: data.status,
      error: data.error,
      startedAt: existing?.startedAt,
      completedAt: existing?.completedAt,
    };
    if (data.status === 'running' && !existing?.startedAt) {
      step.startedAt = now;
    }
    if ((data.status === 'completed' || data.status === 'failed') && !existing?.completedAt) {
      step.completedAt = now;
    }

    // Always persist to the map so it survives thread switches
    const idx = existing ? prev.indexOf(existing) : -1;
    const next =
      idx >= 0 ? prev.map((s, i) => (i === idx ? { ...s, ...step } : s)) : [...prev, step];
    const updates: Partial<ThreadState> = {
      setupProgressByThread: { ...setupProgressByThread, [threadId]: next },
    };

    // Also update activeThread if it matches
    if (activeThread?.id === threadId && activeThread.status === 'setting_up') {
      updates.activeThread = { ...activeThread, setupProgress: next };
    }

    set(updates as any);
  },

  // ── Agent lifecycle actions ──────────────────────────────────

  sendMessage: async (threadId, content, options) => {
    const result = await threadsApi.sendMessage(
      threadId,
      content,
      options ? { model: options.model, permissionMode: options.permissionMode } : undefined,
      options?.images,
    );
    if (result.isErr()) return false;
    return true;
  },

  stopThread: async (threadId) => {
    await threadsApi.stopThread(threadId);
  },

  approveTool: async (threadId, toolName, approved, allowedTools, disallowedTools, options) => {
    const result = await threadsApi.approveTool(
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
    const result = await threadsApi.searchThreadContent(query, projectId);
    return result.isOk() ? result.value : null;
  },

  handleWSWorktreeSetupComplete: (threadId, data) => {
    const { activeThread, loadThreadsForProject, setupProgressByThread } = get();

    // Clean up the setup progress map
    const { [threadId]: _, ...restProgress } = setupProgressByThread;
    const updates: Partial<ThreadState> = {
      setupProgressByThread: restProgress,
    };

    if (activeThread?.id === threadId) {
      updates.activeThread = {
        ...activeThread,
        status: activeThread.status === 'setting_up' ? 'pending' : activeThread.status,
        branch: data.branch,
        ...(data.worktreePath ? { worktreePath: data.worktreePath } : {}),
        setupProgress: undefined,
      };
    }

    set(updates as any);

    // Refresh thread list so sidebar picks up the new status
    if (activeThread?.projectId) {
      loadThreadsForProject(activeThread.projectId);
    }
  },
}));

// Register with the bridge so project-store can access thread state without a direct import
registerThreadStore(useThreadStore);

// ── Thread index subscriber ──────────────────────────────────
// Keep the threadId→projectId index in sync with threadsByProject.
// This runs synchronously after every store update that touches threadsByProject.
let _prevThreadsByProject: Record<string, any[]> = {};
useThreadStore.subscribe((state) => {
  if (state.threadsByProject !== _prevThreadsByProject) {
    _prevThreadsByProject = state.threadsByProject;
    rebuildThreadProjectIndex(state.threadsByProject);
  }
});

// ── Active thread cache subscriber ────────────────────────────
// Mirror the latest activeThread reference into the LRU cache so that
// switching back to it later avoids the network round trip. WS handlers
// already produce fresh references on every meaningful update — by piping
// through this subscriber we keep the cache patched without touching them.
let _prevActiveThread: ThreadWithMessages | null = null;
useThreadStore.subscribe((state) => {
  const current = state.activeThread;
  if (current === _prevActiveThread) return;
  _prevActiveThread = current;
  if (current) cachePut(current.id, current);
});
