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

import { useProjectStore } from './project-store';
import { transitionThreadStatus, cleanupThreadActor } from './thread-machine-bridge';
import {
  nextSelectGeneration,
  getSelectGeneration,
  getBufferedInitInfo,
  setBufferedInitInfo,
  getAndClearWSBuffer,
  clearWSBuffer,
  getSelectingThreadId,
  setSelectingThreadId,
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
}

export interface ThreadState {
  threadsByProject: Record<string, Thread[]>;
  selectedThreadId: string | null;
  activeThread: ThreadWithMessages | null;
  /** Setup progress keyed by threadId — survives thread switches */
  setupProgressByThread: Record<string, import('@/components/GitProgressModal').GitProgressStep[]>;
  /** Context usage keyed by threadId — survives thread switches */
  contextUsageByThread: Record<string, ContextUsage>;

  loadThreadsForProject: (projectId: string) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
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
    threadPromise: ReturnType<typeof api.getThread>;
    eventsPromise: ReturnType<typeof api.getThreadEvents>;
  }
>();
{
  const m = window.location.pathname.match(/\/projects\/[^/]+\/threads\/([^/]+)/);
  if (m) {
    const threadId = m[1];
    _prefetchCache.set(threadId, {
      threadPromise: api.getThread(threadId, 50),
      eventsPromise: api.getThreadEvents(threadId),
    });
  }
}

// ── Store ────────────────────────────────────────────────────────

const _threadLoadPromises = new Map<string, Promise<void>>();

export const useThreadStore = create<ThreadState>((set, get) => ({
  threadsByProject: {},
  selectedThreadId: null,
  activeThread: null,
  setupProgressByThread: {},
  contextUsageByThread: {},

  loadThreadsForProject: async (projectId: string) => {
    // Deduplicate concurrent loads for the same project
    const existing = _threadLoadPromises.get(projectId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await api.listThreads(projectId, true);
        if (result.isOk()) {
          set((state) => ({
            threadsByProject: { ...state.threadsByProject, [projectId]: result.value },
          }));
        }
      } finally {
        _threadLoadPromises.delete(projectId);
      }
    })();

    _threadLoadPromises.set(projectId, promise);
    return promise;
  },

  selectThread: async (threadId) => {
    // Short-circuit when already deselected to avoid no-op state churn
    if (!threadId && !get().selectedThreadId && !get().activeThread) return;

    // Skip if already loading this exact thread (prevents StrictMode double-fire)
    if (threadId && threadId === getSelectingThreadId()) return;

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
      setSelectingThreadId(null);
      return;
    }

    try {
      // Use prefetched data if available (fired at module load time), otherwise fetch now
      const prefetched = _prefetchCache.get(threadId);
      _prefetchCache.delete(threadId);
      const [result, eventsResult] = await Promise.all([
        prefetched?.threadPromise ?? api.getThread(threadId, 50),
        prefetched?.eventsPromise ?? api.getThreadEvents(threadId),
      ]);

      if (result.isErr()) {
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
      const projectStore = useProjectStore.getState();
      if (!projectStore.expandedProjects.has(projectId)) {
        const next = new Set(projectStore.expandedProjects);
        next.add(projectId);
        useProjectStore.setState({ expandedProjects: next });
      }
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
              /permission|hasn't been granted|not in the allowed tools/i.test(lastTC.output)
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
          compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
        },
      });
      useProjectStore.setState({ selectedProjectId: projectId });

      // Replay any WS events that arrived while activeThread was loading
      flushWSBuffer(threadId, get());
    } finally {
      // Clear in-flight tracker so future selectThread calls for this thread can proceed
      if (getSelectingThreadId() === threadId) {
        setSelectingThreadId(null);
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
    // Optimistic: update UI immediately, then fire API in background
    cleanupThreadActor(threadId);
    const { threadsByProject, selectedThreadId } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.filter((t) => t.id !== threadId),
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
          const project = useProjectStore.getState().projects.find((p) => p.id === pid);
          const cwd = activeThread.worktreePath || project?.path || '';
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
    set({
      activeThread: {
        ...activeThread,
        messages: nextMessages,
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
      api.getThread(activeThread.id),
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
        const result = await api.listThreads(pid, true);
        return { pid, threads: result.isOk() ? result.value : null };
      }),
    );

    const prev = get().threadsByProject;
    let changed = false;
    const next: Record<string, Thread[]> = { ...prev };
    for (const { pid, threads } of results) {
      if (threads && threads !== prev[pid]) {
        next[pid] = threads;
        changed = true;
      }
    }
    if (changed) set({ threadsByProject: next });

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
