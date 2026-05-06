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
  PermissionMode,
} from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';
import { metric, startSpan } from '@/lib/telemetry';

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
} from './thread-store-internals';
import * as wsHandlers from './thread-ws-handlers';
import { useUIStore } from './ui-store';

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
  pendingPermission?: { toolName: string };
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
  threadsByProject: Record<string, Thread[]>;
  /** Total thread count per project (from server pagination) */
  threadTotalByProject: Record<string, number>;
  selectedThreadId: string | null;
  activeThread: ThreadWithMessages | null;
  /** Setup progress keyed by threadId — survives thread switches */
  setupProgressByThread: Record<string, import('@/components/GitProgressModal').GitProgressStep[]>;
  /** Context usage keyed by threadId — survives thread switches */
  contextUsageByThread: Record<string, ContextUsage>;
  /** Queued message count keyed by threadId — survives thread switches */
  queuedCountByThread: Record<string, number>;

  loadThreadsForProject: (projectId: string, includeArchived?: boolean) => Promise<void>;
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
  appendOptimisticMessage: (
    threadId: string,
    content: string,
    images?: any[],
    model?: AgentModel,
    permissionMode?: PermissionMode,
    fileReferences?: { path: string; type?: 'file' | 'folder' }[],
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
// fetching thread data immediately — in parallel with auth bootstrap and
// project loading — instead of waiting for useRouteSync.
const PREFETCH_CACHE_LIMIT = 8;
const _prefetchCache = new Map<
  string,
  {
    threadPromise: ReturnType<typeof api.getThread>;
    eventsPromise: ReturnType<typeof api.getThreadEvents>;
  }
>();

function setPrefetch(
  threadId: string,
  entry: {
    threadPromise: ReturnType<typeof api.getThread>;
    eventsPromise: ReturnType<typeof api.getThreadEvents>;
  },
) {
  if (_prefetchCache.size >= PREFETCH_CACHE_LIMIT) {
    const oldest = _prefetchCache.keys().next().value;
    if (oldest) _prefetchCache.delete(oldest);
  }
  _prefetchCache.set(threadId, entry);
}

{
  const m = window.location.pathname.match(/\/projects\/[^/]+\/threads\/([^/]+)/);
  if (m) {
    const threadId = m[1];
    setPrefetch(threadId, {
      threadPromise: api.getThread(threadId, 50),
      eventsPromise: api.getThreadEvents(threadId),
    });
  }
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

  loadThreadsForProject: async (projectId: string, includeArchived: boolean = false) => {
    // Deduplicate concurrent loads for the same project + flag combo
    const key = `${projectId}|${includeArchived ? 1 : 0}`;
    const existing = _threadLoadPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await api.listThreads(projectId, includeArchived, 50);
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
        _threadLoadPromises.delete(key);
      }
    })();

    _threadLoadPromises.set(key, promise);
    return promise;
  },

  loadMoreThreads: async (projectId: string, includeArchived: boolean = false) => {
    const { threadsByProject } = get();
    const currentThreads = threadsByProject[projectId] ?? [];
    const offset = currentThreads.length;
    const result = await api.listThreads(projectId, includeArchived, 50, offset);
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
    useUIStore.setState({ newThreadProjectId: null, allThreadsProjectId: null });

    if (!threadId) {
      _selectAbortController = null;
      setSelectingThreadId(null);
      return;
    }

    const span = startSpan('thread.select', {
      attributes: { 'thread.id': threadId },
    });
    const startMs = Date.now();
    try {
      // Use prefetched data if available (fired on hover/module-load), otherwise fetch now
      const prefetched = _prefetchCache.get(threadId);
      _prefetchCache.delete(threadId);
      const fromCache = !!prefetched;
      const [result, eventsResult] = await Promise.all([
        prefetched?.threadPromise ?? api.getThread(threadId, 50, abortController.signal),
        prefetched?.eventsPromise ?? api.getThreadEvents(threadId, abortController.signal),
      ]);
      metric('thread.select.network_ms', Date.now() - startMs, {
        attributes: { 'thread.from_cache': fromCache ? '1' : '0' },
      });

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

      const threadEvents = eventsResult.isOk() ? eventsResult.value.events : [];

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

      // Restore cached context usage so the bar survives thread switches
      const storedContextUsage = get().contextUsageByThread[threadId];

      // Restore cached queued count so the queue widget survives thread switches
      const storedQueuedCount = get().queuedCountByThread[threadId];

      set({
        activeThread: {
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
        },
      });
      bridgeSelectProject(projectId);

      // Mark the thread as read so the unread blue dot in the sidebar clears.
      if (thread.completedAt) {
        useThreadReadStore.getState().markRead(threadId, thread.completedAt);
      }

      // Replay any WS events that arrived while activeThread was loading
      flushWSBuffer(threadId, get());
      metric('thread.select.total_ms', Date.now() - startMs);
    } finally {
      span.end();
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

  prefetchThread: (threadId: string) => {
    if (!threadId) return;
    if (_prefetchCache.has(threadId)) return;
    if (get().activeThread?.id === threadId) return;
    if (getSelectingThreadId() === threadId) return;
    setPrefetch(threadId, {
      threadPromise: api.getThread(threadId, 50),
      eventsPromise: api.getThreadEvents(threadId),
    });
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
    const result = await api.archiveThread(threadId, true);
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
    const archiveResult = await api.archiveThread(threadId, false);
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

    const stageResult = await api.updateThreadStage(threadId, stage);
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

    const result = await api.renameThread(threadId, title);
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
    const result = await api.pinThread(threadId, pinned);
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
    }
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
    const result = await api.updateThreadStage(threadId, stage);
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
      await api.stopThread(threadId);
    }
    // Optimistic: update UI immediately, then fire API in background
    cleanupThreadActor(threadId);
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
    api.deleteThread(threadId);
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

    set({ activeThread: { ...activeThread, loadingMore: true } });

    const result = await api.getThreadMessages(activeThread.id, oldestMessage.timestamp, 50);

    const current = get().activeThread;
    if (!current || current.id !== activeThread.id) return;

    if (result.isErr()) {
      set({ activeThread: { ...current, loadingMore: false } });
      return;
    }

    const { messages: olderMessages, hasMore } = result.value;

    // Deduplicate in case of overlapping timestamps
    const existingIds = new Set(current.messages.map((m) => m.id));
    const newMessages = olderMessages.filter((m) => !existingIds.has(m.id));

    set({
      activeThread: {
        ...current,
        messages: [...newMessages, ...current.messages],
        hasMore,
        loadingMore: false,
      },
    });
  },

  refreshActiveThread: async () => {
    const { activeThread } = get();
    if (!activeThread) return;
    const [result, eventsResult] = await Promise.all([
      api.getThread(activeThread.id, 50),
      api.getThreadEvents(activeThread.id),
    ]);
    if (result.isErr()) return; // silently ignore
    const thread = result.value;
    const resultInfo =
      activeThread.resultInfo ??
      (thread.status === 'completed' || thread.status === 'failed'
        ? {
            status: thread.status as 'completed' | 'failed',
            cost: thread.cost,
            duration: 0,
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
    // Clear waitingReason/pendingPermission if server status is no longer waiting
    // (handles case where agent:result WS event was lost during disconnect)
    const isServerWaiting = thread.status === 'waiting';
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
        waitingReason: isServerWaiting ? activeThread.waitingReason : undefined,
        pendingPermission: isServerWaiting ? activeThread.pendingPermission : undefined,
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
        const result = await api.listThreads(pid, false, 50);
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
