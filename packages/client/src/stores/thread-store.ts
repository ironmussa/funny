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

import type {
  Thread,
  MessageRole,
  ThreadStage,
  WaitingReason,
  AgentModel,
  EffortLevel,
  PermissionMode,
} from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { loadContextUsage } from '@/lib/context-usage-storage';
import { metric, startSpan } from '@/lib/telemetry';

import {
  expandProject,
  selectProject as bridgeSelectProject,
  getProjectPath,
  registerThreadStore,
} from './store-bridge';
import {
  transitionThreadStatus,
  cleanupThreadActor,
  prefetchThreadData,
  loadThreadData,
  isThreadDataPrefetched,
  isThreadDataLoaded,
} from './thread-machine-bridge';
import * as mutations from './thread-mutations';
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
  notifyThreadSelected,
  setClearThreadSelection,
} from './thread-store-internals';
import * as wsHandlers from './thread-ws-handlers';

// Re-export for external consumers
export {
  invalidateSelectThread,
  setAppNavigate,
  getSelectingThreadId,
} from './thread-store-internals';

// ── Types ────────────────────────────────────────────────────────

export interface AgentInitInfo {
  tools: string[];
  cwd: string;
  model: string;
}

export interface AgentResultInfo {
  status: 'completed' | 'failed';
  cost: number;
  duration: number;
  error?: string;
}

export interface CompactionEvent {
  trigger: 'manual' | 'auto';
  preTokens: number;
  timestamp: string;
}

export interface ContextUsage {
  cumulativeInputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
}

export interface ThreadWithMessages extends Thread {
  messages: (import('@funny/shared').Message & { toolCalls?: any[] })[];
  threadEvents?: import('@funny/shared').ThreadEvent[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  hasMore?: boolean;
  loadingMore?: boolean;
  contextUsage?: ContextUsage;
  compactionEvents?: CompactionEvent[];
  /** Setup progress steps for threads in setting_up status */
  setupProgress?: import('@/components/GitProgressModal').GitProgressStep[];
  /** Last user message — always available even when messages are paginated */
  lastUserMessage?: import('@funny/shared').Message & { toolCalls?: any[] };
  /** Number of messages currently queued for this thread */
  queuedCount?: number;
  /** Preview of the next queued message */
  queuedNextMessage?: string;
}

export interface ThreadState {
  // ── Single source of truth ─────────────────────────────────
  /** All known threads keyed by id. The only place a Thread row is stored. */
  threadsById: Record<string, Thread>;
  /** Per-project ordered IDs. Order matches the server response. */
  threadIdsByProject: Record<string, string[]>;
  /** Scratch threads (no project) — ordered, most recent first. */
  scratchThreadIds: string[];
  /** Pagination totals returned by the server. */
  threadTotalByProject: Record<string, number>;
  scratchThreadTotal: number;

  selectedThreadId: string | null;
  /**
   * The "thread gordo" map — payload (messages, toolCalls, threadEvents,
   * initInfo, contextUsage, …) for every thread that's currently visible
   * either in the right pane (anchored by `selectedThreadId`) or in a
   * live column (anchored by `registerLiveThread` refcount). Both surfaces
   * read and write through this single map; WS handlers patch it via
   * `mutations.applyThreadDataPatch`, which also mirrors the entry onto
   * `activeThread` when it matches `selectedThreadId`.
   */
  threadDataById: Record<string, ThreadWithMessages>;
  /**
   * Derived mirror of `threadDataById[selectedThreadId]`. Kept in sync by
   * the mutation helpers in `thread-mutations.ts` so legacy consumers that
   * read `s.activeThread` keep working. New code should prefer
   * `useActiveThread()` / `getActiveThread(state)` from this module.
   * @deprecated read from `threadDataById[selectedThreadId]` directly.
   */
  activeThread: ThreadWithMessages | null;
  /** Setup progress keyed by threadId — survives thread switches */
  setupProgressByThread: Record<string, import('@/components/GitProgressModal').GitProgressStep[]>;
  /** Context usage keyed by threadId — survives thread switches */
  contextUsageByThread: Record<string, ContextUsage>;
  /** Queued message count keyed by threadId — survives thread switches */
  queuedCountByThread: Record<string, number>;

  loadThreadsForProject: (projectId: string, includeArchived?: boolean) => Promise<void>;
  /** Load the current user's scratch threads. */
  loadScratchThreads: () => Promise<void>;
  /** Add a freshly created scratch thread to the local cache. */
  addScratchThread: (thread: Thread) => void;
  /** Load the next page of threads for a project (appends to existing list) */
  loadMoreThreads: (projectId: string, includeArchived?: boolean) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
  /**
   * Warm the prefetch cache for a thread (e.g. on hover) so the subsequent
   * selectThread call can resolve from cache instead of awaiting the network.
   * No-op if already cached or if the thread is currently active.
   */
  prefetchThread: (threadId: string) => void;
  archiveThread: (threadId: string, projectId: string) => Promise<void>;
  unarchiveThread: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  renameThread: (threadId: string, projectId: string, title: string) => Promise<void>;
  pinThread: (threadId: string, projectId: string, pinned: boolean) => Promise<void>;
  updateThreadStage: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  deleteThread: (threadId: string, projectId: string) => Promise<void>;
  /** Delete a scratch thread (no project / no worktree). */
  deleteScratchThread: (threadId: string) => Promise<void>;
  appendOptimisticMessage: (
    threadId: string,
    content: string,
    images?: any[],
    model?: AgentModel,
    permissionMode?: PermissionMode,
    fileReferences?: { path: string; type?: 'file' | 'folder' }[],
    effort?: EffortLevel,
  ) => void;
  rollbackOptimisticMessage: (threadId: string) => void;
  loadOlderMessages: () => Promise<void>;
  refreshActiveThread: () => Promise<void>;
  refreshAllLoadedThreads: () => Promise<void>;
  clearProjectThreads: (projectId: string) => void;

  // Agent lifecycle actions — centralize API calls that components previously made directly
  sendMessage: (
    threadId: string,
    content: string,
    options?: {
      model?: AgentModel;
      permissionMode?: PermissionMode;
      images?: any[];
    },
  ) => Promise<boolean>;
  stopThread: (threadId: string) => Promise<void>;
  approveTool: (
    threadId: string,
    toolName: string,
    approved: boolean,
    allowedTools?: string[],
    disallowedTools?: string[],
    options?: { scope?: 'once' | 'always'; pattern?: string; toolInput?: string },
  ) => Promise<boolean>;
  searchThreadContent: (query: string, projectId?: string) => Promise<any>;

  // Thread data registration (for LiveColumnsView and any future surface
  // that needs to keep a thread hydrated outside the right pane).
  registerLiveThread: (threadId: string) => Promise<void>;
  unregisterLiveThread: (threadId: string) => void;

  // WebSocket event handlers
  handleWSInit: (threadId: string, data: AgentInitInfo) => void;
  handleWSMessage: (
    threadId: string,
    data: { messageId?: string; role: string; content: string },
  ) => void;
  handleWSToolCall: (
    threadId: string,
    data: { toolCallId?: string; messageId?: string; name: string; input: unknown },
  ) => void;
  handleWSToolOutput: (threadId: string, data: { toolCallId: string; output: string }) => void;
  handleWSStatus: (threadId: string, data: { status: string }) => void;
  handleWSError: (threadId: string, data: { error?: string }) => void;
  handleWSResult: (threadId: string, data: any) => void;
  handleWSQueueUpdate: (
    threadId: string,
    data: { threadId: string; queuedCount: number; nextMessage?: string },
  ) => void;
  handleWSCompactBoundary: (
    threadId: string,
    data: { trigger: 'manual' | 'auto'; preTokens: number; timestamp: string },
  ) => void;
  handleWSContextUsage: (
    threadId: string,
    data: { inputTokens: number; outputTokens: number; cumulativeInputTokens: number },
  ) => void;

  // Worktree setup progress handlers
  handleWSWorktreeSetup: (
    threadId: string,
    data: {
      step: string;
      label: string;
      status: 'running' | 'completed' | 'failed';
      error?: string;
    },
  ) => void;
  handleWSWorktreeSetupComplete: (
    threadId: string,
    data: { branch: string; worktreePath?: string },
  ) => void;
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
// fetching thread data immediately via the thread-data-machine actor —
// in parallel with auth bootstrap and project loading — instead of waiting
// for useRouteSync.
{
  const m = window.location.pathname.match(/\/projects\/[^/]+\/threads\/([^/]+)/);
  if (m) {
    prefetchThreadData(m[1]);
  }
}

// ── Store ────────────────────────────────────────────────────────

// Ref-count for explicit registrations from live columns. A thread is
// kept in `threadDataById` while EITHER it's the selected thread (implicit
// anchor) OR refcount > 0. When both drop, `_evictIfUnreferenced` removes
// the payload so memory doesn't grow without bound.
const _liveThreadRefCounts = new Map<string, number>();

/** Read the explicit refcount for a thread (0 when not registered). */
function _refCount(threadId: string): number {
  return _liveThreadRefCounts.get(threadId) ?? 0;
}

/**
 * Drop `threadDataById[threadId]` iff there's no remaining anchor
 * (refcount === 0 AND thread is not the currently selected one). Caller
 * is responsible for invoking after a refcount/select change.
 */
function _evictIfUnreferenced(threadId: string): void {
  if (_refCount(threadId) > 0) return;
  const state = useThreadStore.getState();
  if (state.selectedThreadId === threadId) return;
  if (!(threadId in state.threadDataById)) return;
  const { [threadId]: _, ...rest } = state.threadDataById;
  useThreadStore.setState({ threadDataById: rest });
}

// ── Public selector helpers ──────────────────────────────────────
//
// Prefer these over `useThreadStore(s => s.activeThread)` and
// `useThreadStore.getState().activeThread` in new code — they read from
// the source-of-truth map directly so they survive the eventual removal
// of the `activeThread` mirror field.

/** Imperative: resolve the currently selected thread from the map. */
export function getActiveThread(state: ThreadState): ThreadWithMessages | null {
  return state.selectedThreadId ? (state.threadDataById[state.selectedThreadId] ?? null) : null;
}

/** Hook: subscribe to the currently selected thread. */
export function useActiveThread(): ThreadWithMessages | null {
  return useThreadStore((s) =>
    s.selectedThreadId ? (s.threadDataById[s.selectedThreadId] ?? null) : null,
  );
}

const _threadLoadPromises = new Map<string, Promise<void>>();

const refreshLog = createClientLogger('thread-refresh');

type LocalMessage = import('@funny/shared').Message & { toolCalls?: any[] };

/** Merge fresh server messages into the local cache.
 *  Fresh messages are the source of truth for their timestamp window — they
 *  replace local copies by ID and recover anything missed while the WS was
 *  disconnected. Older paginated messages and locally-newer optimistic
 *  messages are preserved. */
function mergeMessagesById(local: LocalMessage[], fresh: LocalMessage[]): LocalMessage[] {
  if (fresh.length === 0) return local;

  const freshTimes = fresh.map((m) => new Date(m.timestamp).getTime());
  const oldest = Math.min(...freshTimes);
  const newest = Math.max(...freshTimes);
  const freshIds = new Set(fresh.map((m) => m.id));

  const before: LocalMessage[] = [];
  const after: LocalMessage[] = [];
  for (const m of local) {
    if (freshIds.has(m.id)) continue;
    const t = new Date(m.timestamp).getTime();
    if (t < oldest) before.push(m);
    else if (t > newest) after.push(m);
    // Within the fresh window but not in fresh — likely an optimistic
    // duplicate the server has since superseded; drop it.
  }
  return [...before, ...fresh, ...after];
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threadsById: {},
  threadIdsByProject: {},
  scratchThreadIds: [],
  threadTotalByProject: {},
  scratchThreadTotal: 0,
  selectedThreadId: null,
  threadDataById: {},
  activeThread: null,
  setupProgressByThread: {},
  contextUsageByThread: {},
  queuedCountByThread: {},

  loadScratchThreads: async () => {
    const result = await api.listScratchThreads(100);
    if (result.isOk()) {
      set((state) =>
        mutations.replaceScratchThreads(state, result.value.threads, result.value.total),
      );
    }
  },

  addScratchThread: (thread: Thread) => {
    set((state) => mutations.prependScratchThread(state, thread));
  },

  loadThreadsForProject: async (projectId: string, includeArchived: boolean = false) => {
    // Reject empty/falsy projectId. An empty string would otherwise reach
    // api.listThreads(undefined) and return every user thread, then store
    // them under threadIdsByProject[''], duplicating every sidebar entry.
    // Scratch threads (projectId === '') are loaded via loadScratchThreads.
    if (!projectId) return;
    // Deduplicate concurrent loads for the same project + flag combo
    const key = `${projectId}|${includeArchived ? 1 : 0}`;
    const existing = _threadLoadPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await api.listThreads(projectId, includeArchived, 50);
        if (result.isOk()) {
          set((state) =>
            mutations.replaceProjectThreads(
              state,
              projectId,
              result.value.threads,
              result.value.total,
            ),
          );
        }
      } finally {
        _threadLoadPromises.delete(key);
      }
    })();

    _threadLoadPromises.set(key, promise);
    return promise;
  },

  loadMoreThreads: async (projectId: string, includeArchived: boolean = false) => {
    const currentIds = get().threadIdsByProject[projectId] ?? [];
    const result = await api.listThreads(projectId, includeArchived, 50, currentIds.length);
    if (result.isOk()) {
      set((state) =>
        mutations.appendProjectThreads(state, projectId, result.value.threads, result.value.total),
      );
    }
  },

  selectThread: async (threadId) => {
    // Short-circuit when already deselected to avoid no-op state churn
    if (!threadId && !get().selectedThreadId && !get().activeThread) return;

    // Skip if already loading this exact thread (prevents StrictMode double-fire)
    if (threadId && threadId === getSelectingThreadId()) return;

    const gen = nextSelectGeneration();
    // Allocate span / timer BEFORE claiming the in-flight slot so a synchronous
    // failure in `startSpan` (telemetry init, transport, etc.) can't leave
    // `selectingThreadId` stuck on `threadId`. If that ever happened, every
    // future `selectThread(threadId)` would short-circuit at the line-478
    // guard and `useRouteSync`'s invariant re-select would also no-op — the
    // exact "URL changes but the active thread doesn't" symptom.
    const span = threadId
      ? startSpan('thread.select', { attributes: { 'thread.id': threadId } })
      : null;
    const startMs = Date.now();
    setSelectingThreadId(threadId);
    try {
      // When switching to a different thread, only keep the previous payload
      // visible if the target thread's data is already fully cached (instant swap).
      // Otherwise clear it so ThreadView shows its loading spinner immediately —
      // showing the previous thread's content during a real network fetch reads
      // as "click did nothing" and is the dominant source of perceived delay.
      const prevSelectedId = get().selectedThreadId;
      const prevActive = get().activeThread;
      const isDifferentThread = !!(threadId && prevActive && prevActive.id !== threadId);
      const cacheHit = !!threadId && isThreadDataLoaded(threadId);
      const keepStale = isDifferentThread && cacheHit;

      // Compute the new active mirror. If the target thread is already in the
      // map (e.g. it was anchored by a live column), point at that entry —
      // this is the unified-store "instant swap" path.
      set((state) => {
        const targetEntry = threadId ? (state.threadDataById[threadId] ?? null) : null;
        const nextActive = targetEntry
          ? targetEntry
          : keepStale
            ? prevActive
            : threadId && !isDifferentThread
              ? prevActive
              : null;
        return {
          selectedThreadId: threadId,
          activeThread: nextActive,
        };
      });
      notifyThreadSelected();

      // The previously-selected thread loses its implicit anchor; evict if no
      // explicit registration is holding it. Skip when the user deselected
      // back to the same thread (no-op above).
      //
      // CRITICAL: in the `keepStale` path we just set `activeThread=prevActive`
      // so the right pane keeps showing the previous thread while the new one
      // loads. Evicting `prevSelectedId` from `threadDataById` here would
      // leave `activeThread` pointing at an entry no longer in the map — the
      // back-fill subscriber would then "fix the drift" by forcing
      // `selectedThreadId` back to the previous thread, manifesting as
      // "URL changes to /B but the right pane keeps showing A". Defer the
      // eviction to the post-load path below, after `setThreadData(threadId)`
      // has repointed `activeThread` at the new thread.
      if (prevSelectedId && prevSelectedId !== threadId && !keepStale) {
        _evictIfUnreferenced(prevSelectedId);
      }

      if (!threadId) return;

      const fromCache = isThreadDataPrefetched(threadId);
      let snapshot;
      try {
        snapshot = await loadThreadData(threadId);
      } catch {
        metric('thread.select.network_ms', Date.now() - startMs, {
          attributes: { 'thread.from_cache': fromCache ? '1' : '0' },
        });
        if (getSelectGeneration() === gen) {
          clearWSBuffer(threadId);
          set({ selectedThreadId: null, activeThread: null });
          // Drop any half-populated entry too so a retry starts clean.
          _evictIfUnreferenced(threadId);
        }
        return;
      }
      metric('thread.select.network_ms', Date.now() - startMs, {
        attributes: { 'thread.from_cache': fromCache ? '1' : '0' },
      });

      const thread = snapshot.thread;

      if (getSelectGeneration() !== gen) {
        clearWSBuffer(threadId);
        return;
      }

      const projectId = thread.projectId;

      // Ensure project is expanded and threads are loaded
      expandProject(projectId);
      if (!get().threadIdsByProject[projectId]) {
        get().loadThreadsForProject(projectId);
      }

      const buffered = getBufferedInitInfo(threadId);
      const resultInfo =
        thread.status === 'completed' || thread.status === 'failed'
          ? {
              status: thread.status as 'completed' | 'failed',
              cost: thread.cost,
              duration: 0,
              error: (thread as any).error,
            }
          : undefined;

      // Derive waitingReason and pendingPermission from the last tool call when reloading a waiting thread
      let waitingReason: WaitingReason | undefined;
      let pendingPermission: { toolName: string } | undefined;
      if (thread.status === 'waiting' && thread.messages?.length) {
        for (let i = thread.messages.length - 1; i >= 0; i--) {
          const tcs = thread.messages[i].toolCalls;
          if (tcs?.length) {
            const lastTC = tcs[tcs.length - 1];
            if (lastTC.name === 'AskUserQuestion') {
              waitingReason = 'question';
            } else if (lastTC.name === 'ExitPlanMode') {
              waitingReason = 'plan';
            } else if (
              lastTC.output &&
              /permission|hasn't been granted|not in the allowed tools|hook error:.*approval|denied this tool|Blocked by hook/i.test(
                lastTC.output,
              )
            ) {
              waitingReason = 'permission';
              pendingPermission = { toolName: lastTC.name };
            }
            break;
          }
        }
      }

      const threadEvents = snapshot.events;

      // Reconstruct compactionEvents from persisted thread events so they survive refreshes
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

      // Merge stored setup progress for setting_up threads
      const storedSetupProgress =
        thread.status === 'setting_up' ? get().setupProgressByThread[threadId] : undefined;

      // Restore cached context usage so the ring survives thread switches and
      // page reloads. Falls back to localStorage when the in-memory map is empty
      // (e.g. fresh tab) so the ring re-appears before the next WS event fires.
      const storedContextUsage = get().contextUsageByThread[threadId] ?? loadContextUsage(threadId);

      // Restore cached queued count so the queue widget survives thread switches
      const storedQueuedCount = get().queuedCountByThread[threadId];

      const hydrated: ThreadWithMessages = {
        ...thread,
        hasMore: thread.hasMore ?? false,
        threadEvents,
        initInfo: thread.initInfo || buffered || undefined,
        resultInfo,
        waitingReason,
        pendingPermission,
        setupProgress: storedSetupProgress,
        contextUsage: storedContextUsage,
        queuedCount: storedQueuedCount,
        compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
      };
      set((state) => mutations.setThreadData(state, threadId, hydrated));

      // Deferred eviction for the `keepStale` path: we skipped it above so the
      // back-fill subscriber wouldn't see `activeThread` pointing at an entry
      // missing from `threadDataById`. Now that `setThreadData` has repointed
      // `activeThread` at the new thread, it's safe to drop the old payload.
      if (keepStale && prevSelectedId && prevSelectedId !== threadId) {
        _evictIfUnreferenced(prevSelectedId);
      }

      bridgeSelectProject(projectId);

      // Mark the thread as read so the unread blue dot in the sidebar clears.
      if (thread.completedAt) {
        useThreadReadStore.getState().markRead(threadId, thread.completedAt);
      }

      // Replay any WS events that arrived while activeThread was loading
      flushWSBuffer(threadId, get());
      metric('thread.select.total_ms', Date.now() - startMs);
    } finally {
      span?.end();
      // Clear in-flight tracker so future selectThread calls for this thread can proceed.
      // We check getSelectGeneration() === gen to ensure we don't accidentally clear
      // the lock for a newer selectThread call to the *same* threadId that started
      // while we were waiting (e.g. A -> B -> A rapid clicks).
      if (getSelectGeneration() === gen && getSelectingThreadId() === threadId) {
        setSelectingThreadId(null);
      }
    }
  },

  prefetchThread: (threadId: string) => {
    if (!threadId) return;
    if (get().activeThread?.id === threadId) return;
    if (getSelectingThreadId() === threadId) return;
    prefetchThreadData(threadId);
  },

  archiveThread: async (threadId) => {
    set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, archived: true })));

    const result = await api.archiveThread(threadId, true);
    if (result.isErr()) {
      set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, archived: false })));
      return;
    }
    cleanupThreadActor(threadId);
  },

  unarchiveThread: async (threadId, _projectId, stage) => {
    const oldStage = get().threadsById[threadId]?.stage ?? 'backlog';

    set((state) =>
      mutations.patchThread(state, threadId, (t) => ({ ...t, archived: false, stage })),
    );

    const archiveResult = await api.archiveThread(threadId, false);
    if (archiveResult.isErr()) {
      set((state) =>
        mutations.patchThread(state, threadId, (t) => ({
          ...t,
          archived: true,
          stage: oldStage,
        })),
      );
      return;
    }

    const stageResult = await api.updateThreadStage(threadId, stage);
    if (stageResult.isErr()) {
      set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, stage: oldStage })));
    }
  },

  renameThread: async (threadId, _projectId, title) => {
    const oldTitle = get().threadsById[threadId]?.title ?? '';

    set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, title })));

    const result = await api.renameThread(threadId, title);
    if (result.isErr()) {
      set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, title: oldTitle })));
    }
  },

  pinThread: async (threadId, _projectId, pinned) => {
    const oldPinned = get().threadsById[threadId]?.pinned;

    set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, pinned })));

    const result = await api.pinThread(threadId, pinned);
    if (result.isErr()) {
      set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, pinned: oldPinned })));
    }
  },

  updateThreadStage: async (threadId, _projectId, stage) => {
    const oldStage = get().threadsById[threadId]?.stage ?? 'backlog';

    set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, stage })));

    const result = await api.updateThreadStage(threadId, stage);
    if (result.isErr()) {
      set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, stage: oldStage })));
    }
  },

  deleteThread: async (threadId) => {
    const thread = get().threadsById[threadId];
    if (thread && (thread.status === 'running' || thread.status === 'waiting')) {
      await api.stopThread(threadId);
    }
    cleanupThreadActor(threadId);
    set((state) => mutations.removeThread(state, threadId));
    _liveThreadRefCounts.delete(threadId);
    set((state) => mutations.clearThreadData(state, threadId));
    if (get().selectedThreadId === threadId) {
      set({ selectedThreadId: null, activeThread: null });
    }
    api.deleteThread(threadId);
  },

  deleteScratchThread: async (threadId) => {
    const thread = get().threadsById[threadId];
    if (thread && (thread.status === 'running' || thread.status === 'waiting')) {
      await api.stopThread(threadId);
    }
    cleanupThreadActor(threadId);
    set((state) => mutations.removeThread(state, threadId));
    _liveThreadRefCounts.delete(threadId);
    set((state) => mutations.clearThreadData(state, threadId));
    if (get().selectedThreadId === threadId) {
      set({ selectedThreadId: null, activeThread: null });
    }
    api.deleteThread(threadId);
  },

  appendOptimisticMessage: (
    threadId,
    content,
    images,
    model,
    permissionMode,
    fileReferences,
    effort,
  ) => {
    // Operate on the unified payload map so this works from the right pane
    // AND from any live column — anywhere the thread is currently loaded.
    const entry = get().threadDataById[threadId];
    if (!entry) return;
    const pid = entry.projectId;

    const machineEvent = { type: 'START' as const };
    const newStatus = transitionThreadStatus(threadId, machineEvent, entry.status, entry.cost);

    // Pre-populate initInfo so the card renders immediately instead of
    // waiting for the agent:init WebSocket event from the server.
    const initInfo =
      entry.initInfo ??
      (() => {
        const projectPath = getProjectPath(pid);
        const cwd = entry.worktreePath || projectPath || '';
        return { model: model || entry.model, cwd, tools: [] as string[] };
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
      effort,
    };

    // For idle threads (backlog/planning), a draft user message already exists —
    // replace it instead of appending a duplicate.
    const existingDraftIdx =
      entry.status === 'idle' ? entry.messages.findIndex((m) => m.role === 'user') : -1;
    const nextMessages =
      existingDraftIdx >= 0
        ? entry.messages.map((m, i) => (i === existingDraftIdx ? newMessage : m))
        : entry.messages.concat(newMessage);

    set((state) => ({
      // Sidebar status — keeps the row badge in sync regardless of bucket.
      ...mutations.patchThread(state, threadId, (t) => ({ ...t, status: newStatus })),
      // Payload patch — also mirrors to activeThread when this is the
      // selected thread.
      ...mutations.applyThreadDataPatch(state, threadId, (t) => ({
        ...t,
        initInfo,
        status: newStatus,
        initialPrompt: undefined,
        waitingReason: undefined,
        pendingPermission: undefined,
        permissionMode: permissionMode || t.permissionMode,
        messages: nextMessages,
        lastUserMessage: newMessage,
      })),
    }));
  },

  rollbackOptimisticMessage: (threadId) => {
    set((state) =>
      mutations.applyThreadDataPatch(state, threadId, (t) => {
        let lastUserIdx = -1;
        for (let i = t.messages.length - 1; i >= 0; i--) {
          if (t.messages[i].role === 'user') {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx < 0) return t;
        const nextMessages = t.messages.filter((_, i) => i !== lastUserIdx);
        const prevUserMsg = [...nextMessages].reverse().find((m) => m.role === 'user');
        return {
          ...t,
          messages: nextMessages,
          lastUserMessage: prevUserMsg ?? t.lastUserMessage,
        };
      }),
    );
  },

  loadOlderMessages: async () => {
    const active = getActiveThread(get());
    if (!active || !active.hasMore || active.loadingMore) return;

    const oldestMessage = active.messages[0];
    if (!oldestMessage) return;
    const threadId = active.id;

    set((state) =>
      mutations.applyThreadDataPatch(state, threadId, (t) => ({ ...t, loadingMore: true })),
    );

    const result = await api.getThreadMessages(threadId, oldestMessage.timestamp, 50);

    // Bail if user switched away. The map entry might be evicted by now.
    const current = get().threadDataById[threadId];
    if (!current) return;

    if (result.isErr()) {
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) => ({ ...t, loadingMore: false })),
      );
      return;
    }

    const { messages: olderMessages, hasMore } = result.value;
    set((state) =>
      mutations.applyThreadDataPatch(state, threadId, (t) => {
        // Deduplicate in case of overlapping timestamps
        const existingIds = new Set(t.messages.map((m) => m.id));
        const newMessages = olderMessages.filter((m) => !existingIds.has(m.id));
        return {
          ...t,
          messages: [...newMessages, ...t.messages],
          hasMore,
          loadingMore: false,
        };
      }),
    );
  },

  refreshActiveThread: async () => {
    const active = getActiveThread(get());
    if (!active) return;
    const threadId = active.id;
    const [result, eventsResult] = await Promise.all([
      api.getThread(threadId, 50),
      api.getThreadEvents(threadId),
    ]);
    if (result.isErr()) return; // silently ignore
    const thread = result.value;
    const eventsFallback = active.threadEvents;
    const threadEvents = eventsResult.isOk() ? eventsResult.value.events : eventsFallback;

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
    // Clear waitingReason/pendingPermission if server status is no longer waiting
    // (handles case where agent:result WS event was lost during disconnect)
    const isServerWaiting = thread.status === 'waiting';

    // Merge messages — recovers any agent:message / agent:tool_call events that
    // were emitted by the server while the WebSocket was disconnected. The
    // server is source of truth for the recent window; older paginated
    // messages already loaded by the client are preserved.
    //
    // Use the functional set() form so the merge base + spread base read the
    // freshest payload from the map. Without this, a WS agent:message that
    // arrives during the await above gets clobbered.
    const freshMessages = (thread.messages ?? []) as LocalMessage[];
    set((state) =>
      mutations.applyThreadDataPatch(state, threadId, (current) => {
        const mergedMessages = mergeMessagesById(current.messages, freshMessages);
        const recovered = mergedMessages.length - current.messages.length;
        if (recovered > 0) {
          refreshLog.info('Recovered missed messages on resync', {
            threadId,
            recovered,
            local: current.messages.length,
            fresh: freshMessages.length,
            merged: mergedMessages.length,
          });
          metric('thread.resync.messages_recovered', recovered, {
            attributes: { 'thread.id': threadId },
          });
        }
        const resultInfo =
          current.resultInfo ??
          (thread.status === 'completed' || thread.status === 'failed'
            ? {
                status: thread.status as 'completed' | 'failed',
                cost: thread.cost,
                duration: 0,
                error: (thread as any).error,
              }
            : undefined);
        return {
          ...current,
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
          initInfo: current.initInfo,
          resultInfo,
          threadEvents,
          messages: mergedMessages,
          lastUserMessage: thread.lastUserMessage ?? current.lastUserMessage,
          hasMore: thread.hasMore ?? current.hasMore,
          compactionEvents:
            persistedCompaction.length > 0 ? persistedCompaction : current.compactionEvents,
          contextUsage: current.contextUsage,
          waitingReason: isServerWaiting ? current.waitingReason : undefined,
          pendingPermission: isServerWaiting ? current.pendingPermission : undefined,
        };
      }),
    );
  },

  refreshAllLoadedThreads: async () => {
    const projectIds = Object.keys(get().threadIdsByProject);

    // Fetch all projects in parallel, then apply each result through the
    // shared mutation so threadsById stays the single source of truth.
    const results = await Promise.all(
      projectIds.map(async (pid) => {
        const result = await api.listThreads(pid, false, 50);
        return {
          pid,
          threads: result.isOk() ? result.value.threads : null,
          total: result.isOk() ? result.value.total : 0,
        };
      }),
    );

    set((state) => {
      let patch: Partial<ThreadState> = {};
      let workingState = state;
      for (const { pid, threads, total } of results) {
        if (!threads) continue;
        const sub = mutations.replaceProjectThreads(workingState, pid, threads, total);
        patch = { ...patch, ...sub };
        workingState = { ...workingState, ...sub } as ThreadState;
      }
      return patch;
    });

    await get().refreshActiveThread();
  },

  clearProjectThreads: (projectId: string) => {
    set((state) => {
      const ids = state.threadIdsByProject[projectId];
      const bucketPatch = mutations.clearProjectBucket(state, projectId);
      let patch: Partial<ThreadState> = { ...bucketPatch };
      if (ids && ids.length) {
        // Drop any payload entries that belonged to the cleared project. Use a
        // working state so multiple deletions compose without losing earlier
        // map mutations.
        let working: ThreadState = { ...state, ...patch } as ThreadState;
        for (const id of ids) {
          _liveThreadRefCounts.delete(id);
          const sub = mutations.clearThreadData(working, id);
          patch = { ...patch, ...sub };
          working = { ...working, ...sub } as ThreadState;
        }
      }
      const active = state.activeThread;
      const clearSelection = active?.projectId === projectId;
      return {
        ...patch,
        ...(clearSelection ? { selectedThreadId: null, activeThread: null } : {}),
      };
    });
  },

  // ── Thread data registration ────────────────────────────────
  //
  // A "registration" is an explicit anchor on `threadDataById[id]`. Live
  // columns register on mount so the payload stays loaded for streaming;
  // the right pane anchors implicitly via `selectedThreadId`. A thread is
  // evicted from the map only when BOTH anchors drop.

  registerLiveThread: async (threadId) => {
    const prev = _liveThreadRefCounts.get(threadId) ?? 0;
    _liveThreadRefCounts.set(threadId, prev + 1);

    // Already hydrated (either by a previous register or because it's the
    // selected thread) — just hold the anchor.
    if (get().threadDataById[threadId]) return;
    if (prev > 0) return; // a sibling registration is racing the same fetch

    const result = await api.getThread(threadId, 50);
    if (result.isErr()) return;

    // Refcount may have dropped while fetching (unmount, race) — only land
    // the data if someone still wants it.
    if ((_liveThreadRefCounts.get(threadId) ?? 0) <= 0) return;
    set((state) => mutations.setThreadData(state, threadId, result.value as ThreadWithMessages));
  },

  unregisterLiveThread: (threadId) => {
    const count = (_liveThreadRefCounts.get(threadId) ?? 1) - 1;
    if (count > 0) {
      _liveThreadRefCounts.set(threadId, count);
      return;
    }
    _liveThreadRefCounts.delete(threadId);
    _evictIfUnreferenced(threadId);
  },

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
    const now = Date.now();
    set((state) => {
      const prev = state.setupProgressByThread[threadId] ?? [];
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

      // Always persist to the byThread map so it survives thread switches
      const idx = existing ? prev.indexOf(existing) : -1;
      const next =
        idx >= 0 ? prev.map((s, i) => (i === idx ? { ...s, ...step } : s)) : [...prev, step];

      return {
        setupProgressByThread: { ...state.setupProgressByThread, [threadId]: next },
        // Mirror onto the loaded payload (right pane OR live column). The
        // patch is a no-op when the thread isn't loaded.
        ...mutations.applyThreadDataPatch(state, threadId, (t) =>
          t.status === 'setting_up' ? { ...t, setupProgress: next } : t,
        ),
      };
    });
  },

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

  handleWSWorktreeSetupComplete: (threadId, data) => {
    const { loadThreadsForProject } = get();

    set((state) => {
      const { [threadId]: _, ...restProgress } = state.setupProgressByThread;
      return {
        setupProgressByThread: restProgress,
        ...mutations.applyThreadDataPatch(state, threadId, (t) => ({
          ...t,
          status: t.status === 'setting_up' ? 'pending' : t.status,
          branch: data.branch,
          ...(data.worktreePath ? { worktreePath: data.worktreePath } : {}),
          setupProgress: undefined,
        })),
      };
    });

    // Refresh thread list so sidebar picks up the new status. Look up the
    // project from the unified payload map (or the sidebar index as fallback).
    const t = get().threadDataById[threadId] ?? get().threadsById[threadId];
    if (t?.projectId) {
      loadThreadsForProject(t.projectId);
    }
  },
}));

// Register with the bridge so project-store can access thread state without a direct import
registerThreadStore(useThreadStore);
setClearThreadSelection(() => {
  useThreadStore.setState({ selectedThreadId: null, activeThread: null });
});

// ── Thread index subscriber ──────────────────────────────────
// Keep the threadId→projectId index in sync with threadIdsByProject. Runs
// synchronously after every store update that touches the project bucket.
let _prevThreadIdsByProject: Record<string, string[]> = {};
useThreadStore.subscribe((state) => {
  if (state.threadIdsByProject !== _prevThreadIdsByProject) {
    _prevThreadIdsByProject = state.threadIdsByProject;
    rebuildThreadProjectIndex(state.threadIdsByProject);
  }
});

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
  useThreadStore.setState({
    threadDataById: { ...state.threadDataById, [at.id]: at },
    ...(state.selectedThreadId === at.id ? {} : { selectedThreadId: at.id }),
  });
});
