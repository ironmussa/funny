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
  activeThread: ThreadWithMessages | null;
  /** Setup progress keyed by threadId — survives thread switches */
  setupProgressByThread: Record<string, import('@/components/GitProgressModal').GitProgressStep[]>;
  /** Context usage keyed by threadId — survives thread switches */
  contextUsageByThread: Record<string, ContextUsage>;
  /** Queued message count keyed by threadId — survives thread switches */
  queuedCountByThread: Record<string, number>;
  /** Thread data for threads visible in live columns — updated in real-time by WS handlers */
  liveThreads: Record<string, ThreadWithMessages>;

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

  // Live thread registration (for LiveColumnsView)
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

// Ref-count for live thread registrations (multiple columns could theoretically
// show the same thread). When count drops to 0, the thread is removed from liveThreads.
const _liveThreadRefCounts = new Map<string, number>();

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
  activeThread: null,
  setupProgressByThread: {},
  contextUsageByThread: {},
  queuedCountByThread: {},
  liveThreads: {},

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
    setSelectingThreadId(threadId);
    // When switching to a different thread, only keep the previous activeThread
    // visible if the target thread's data is already fully cached (instant swap).
    // Otherwise clear it so ThreadView shows its loading spinner immediately —
    // showing the previous thread's content during a real network fetch reads
    // as "click did nothing" and is the dominant source of perceived delay.
    const prevActive = get().activeThread;
    const isDifferentThread = !!(threadId && prevActive && prevActive.id !== threadId);
    const cacheHit = !!threadId && isThreadDataLoaded(threadId);
    const keepStale = isDifferentThread && cacheHit;
    set({
      selectedThreadId: threadId,
      activeThread: keepStale ? prevActive : threadId && !isDifferentThread ? prevActive : null,
    });
    notifyThreadSelected();

    if (!threadId) {
      setSelectingThreadId(null);
      return;
    }

    const span = startSpan('thread.select', {
      attributes: { 'thread.id': threadId },
    });
    const startMs = Date.now();
    try {
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
    if (get().selectedThreadId === threadId) {
      set({ selectedThreadId: null, activeThread: null });
    }
    api.deleteThread(threadId);
  },

  appendOptimisticMessage: (threadId, content, images, model, permissionMode, fileReferences) => {
    const { activeThread } = get();
    if (activeThread?.id !== threadId) return;
    const pid = activeThread.projectId;

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

    // Patch sidebar row status; activeThread is updated separately below to
    // also carry the optimistic message/initInfo (which patchThread doesn't).
    set((state) => mutations.patchThread(state, threadId, (t) => ({ ...t, status: newStatus })));
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
    });
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

    // Merge messages — recovers any agent:message / agent:tool_call events that
    // were emitted by the server while the WebSocket was disconnected. The
    // server is source of truth for the recent window; older paginated
    // messages already loaded by the client are preserved.
    //
    // Use the functional set() form so the merge base + spread base read the
    // freshest activeThread. Without this, a WS agent:message that arrives
    // during the await above gets clobbered: the captured `activeThread`
    // reference doesn't see the WS update, so the merge runs on a stale local
    // and the spread overwrites the WS-applied message.
    const freshMessages = (thread.messages ?? []) as LocalMessage[];
    set((state) => {
      const current = state.activeThread;
      // Bail if user switched away from this thread mid-fetch.
      if (!current || current.id !== activeThread.id) return {};

      const mergedMessages = mergeMessagesById(current.messages, freshMessages);
      const recovered = mergedMessages.length - current.messages.length;
      if (recovered > 0) {
        refreshLog.info('Recovered missed messages on resync', {
          threadId: current.id,
          recovered,
          local: current.messages.length,
          fresh: freshMessages.length,
          merged: mergedMessages.length,
        });
        metric('thread.resync.messages_recovered', recovered, {
          attributes: { 'thread.id': current.id },
        });
      }

      return {
        activeThread: {
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
        },
      };
    });
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
      const clearSelection = state.activeThread?.projectId === projectId;
      return {
        ...mutations.clearProjectBucket(state, projectId),
        ...(clearSelection ? { selectedThreadId: null, activeThread: null } : {}),
      };
    });
  },

  // ── Live thread registration ─────────────────────────────────

  registerLiveThread: async (threadId) => {
    const prev = _liveThreadRefCounts.get(threadId) ?? 0;
    _liveThreadRefCounts.set(threadId, prev + 1);
    if (prev > 0) return; // already registered — just bump refcount

    const result = await api.getThread(threadId, 50);
    if (result.isErr()) return;

    // Check refcount is still > 0 (may have been unregistered while fetching)
    if ((_liveThreadRefCounts.get(threadId) ?? 0) <= 0) return;

    const { liveThreads } = get();
    set({ liveThreads: { ...liveThreads, [threadId]: result.value as ThreadWithMessages } });
  },

  unregisterLiveThread: (threadId) => {
    const count = (_liveThreadRefCounts.get(threadId) ?? 1) - 1;
    if (count > 0) {
      _liveThreadRefCounts.set(threadId, count);
      return;
    }
    _liveThreadRefCounts.delete(threadId);
    const { liveThreads } = get();
    if (liveThreads[threadId]) {
      const { [threadId]: _, ...rest } = liveThreads;
      set({ liveThreads: rest });
    }
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
