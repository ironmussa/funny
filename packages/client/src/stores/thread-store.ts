/**
 * Thread store — Zustand store for thread state management.
 * Delegates WebSocket handling to thread-ws-handlers, state machine transitions
 * to thread-machine-bridge, and module-level coordination to thread-store-internals.
 */

import { create } from 'zustand';
import type { Thread, MessageRole, ThreadStatus, ThreadStage, WaitingReason, AgentModel, PermissionMode } from '@funny/shared';
import { api } from '@/lib/api';
import { useUIStore } from './ui-store';
import { useProjectStore } from './project-store';
import {
  nextSelectGeneration,
  getSelectGeneration,
  getBufferedInitInfo,
  setBufferedInitInfo,
  getAndClearWSBuffer,
  clearWSBuffer,
} from './thread-store-internals';
import { transitionThreadStatus, cleanupThreadActor } from './thread-machine-bridge';
import * as wsHandlers from './thread-ws-handlers';

// Re-export for external consumers
export { invalidateSelectThread, setAppNavigate } from './thread-store-internals';

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

export interface ThreadWithMessages extends Thread {
  messages: (import('@funny/shared').Message & { toolCalls?: any[] })[];
  threadEvents?: import('@funny/shared').ThreadEvent[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string };
  hasMore?: boolean;
  loadingMore?: boolean;
}

export interface ThreadState {
  threadsByProject: Record<string, Thread[]>;
  selectedThreadId: string | null;
  activeThread: ThreadWithMessages | null;

  loadThreadsForProject: (projectId: string) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
  archiveThread: (threadId: string, projectId: string) => Promise<void>;
  unarchiveThread: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  pinThread: (threadId: string, projectId: string, pinned: boolean) => Promise<void>;
  updateThreadStage: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  deleteThread: (threadId: string, projectId: string) => Promise<void>;
  appendOptimisticMessage: (threadId: string, content: string, images?: any[], model?: AgentModel, permissionMode?: PermissionMode) => void;
  loadOlderMessages: () => Promise<void>;
  refreshActiveThread: () => Promise<void>;
  refreshAllLoadedThreads: () => Promise<void>;
  clearProjectThreads: (projectId: string) => void;

  // WebSocket event handlers
  handleWSInit: (threadId: string, data: AgentInitInfo) => void;
  handleWSMessage: (threadId: string, data: { messageId?: string; role: string; content: string }) => void;
  handleWSToolCall: (threadId: string, data: { toolCallId?: string; messageId?: string; name: string; input: unknown }) => void;
  handleWSToolOutput: (threadId: string, data: { toolCallId: string; output: string }) => void;
  handleWSStatus: (threadId: string, data: { status: string }) => void;
  handleWSResult: (threadId: string, data: any) => void;
  handleWSQueueUpdate: (threadId: string, data: { threadId: string; queuedCount: number; nextMessage?: string }) => void;
}

// ── Buffer replay ────────────────────────────────────────────────

function flushWSBuffer(threadId: string, store: ThreadState) {
  const events = getAndClearWSBuffer(threadId);
  if (!events) return;
  for (const event of events) {
    switch (event.type) {
      case 'message': store.handleWSMessage(threadId, event.data); break;
      case 'tool_call': store.handleWSToolCall(threadId, event.data); break;
      case 'tool_output': store.handleWSToolOutput(threadId, event.data); break;
      case 'status': store.handleWSStatus(threadId, event.data); break;
      case 'result': store.handleWSResult(threadId, event.data); break;
    }
  }
}

// ── Eager thread prefetch ─────────────────────────────────────────
// Parse the URL at module-load time. If we're on a thread route, start
// fetching thread data immediately — in parallel with auth bootstrap and
// project loading — instead of waiting for useRouteSync.
const _prefetchCache = new Map<string, { threadPromise: ReturnType<typeof api.getThread>; eventsPromise: ReturnType<typeof api.getThreadEvents> }>();
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
    const gen = nextSelectGeneration();
    // Keep stale activeThread visible during load to avoid layout shift.
    // Only clear it if switching to null (deselect) or to a different thread.
    const prevActive = get().activeThread;
    const keepStale = threadId && prevActive && prevActive.id !== threadId;
    set({
      selectedThreadId: threadId,
      activeThread: keepStale ? prevActive : (threadId ? prevActive : null),
    });
    useUIStore.setState({ newThreadProjectId: null, allThreadsProjectId: null });

    if (!threadId) return;

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
    const resultInfo = (thread.status === 'completed' || thread.status === 'failed')
      ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0, error: (thread as any).error }
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
          } else if (lastTC.output && /permission|hasn't been granted|not in the allowed tools/i.test(lastTC.output)) {
            waitingReason = 'permission';
            pendingPermission = { toolName: lastTC.name };
          }
          break;
        }
      }
    }

    const threadEvents = eventsResult.isOk() ? eventsResult.value.events : [];

    set({ activeThread: { ...thread, hasMore: thread.hasMore ?? false, threadEvents, initInfo: thread.initInfo || buffered || undefined, resultInfo, waitingReason, pendingPermission } });
    useProjectStore.setState({ selectedProjectId: projectId });

    // Replay any WS events that arrived while activeThread was loading
    flushWSBuffer(threadId, get());
  },

  archiveThread: async (threadId, projectId) => {
    // Optimistic update: update UI immediately
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];

    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, archived: true } : t
        ),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, archived: true } : activeThread,
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
            t.id === threadId ? { ...t, archived: false } : t
          ),
        },
        activeThread: currentState.activeThread?.id === threadId
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
          t.id === threadId ? { ...t, archived: false, stage } : t
        ),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, archived: false, stage } : activeThread,
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
            t.id === threadId ? { ...t, archived: true, stage: oldStage } : t
          ),
        },
        activeThread: currentState.activeThread?.id === threadId
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
            t.id === threadId ? { ...t, stage: oldStage } : t
          ),
        },
        activeThread: currentState.activeThread?.id === threadId
          ? { ...currentState.activeThread, stage: oldStage }
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
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, pinned } : t
        ),
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
            t.id === threadId ? { ...t, pinned: oldPinned } : t
          ),
        },
        activeThread: currentState.activeThread?.id === threadId
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
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, stage } : t
        ),
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
            t.id === threadId ? { ...t, stage: oldStage } : t
          ),
        },
        activeThread: currentState.activeThread?.id === threadId
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

  appendOptimisticMessage: (threadId, content, images, model, permissionMode) => {
    const { activeThread, threadsByProject } = get();
    if (activeThread?.id === threadId) {
      const pid = activeThread.projectId;
      const projectThreads = threadsByProject[pid] ?? [];

      const machineEvent = { type: 'START' as const };
      const newStatus = transitionThreadStatus(threadId, machineEvent, activeThread.status, activeThread.cost);

      // Pre-populate initInfo so the card renders immediately instead of
      // waiting for the agent:init WebSocket event from the server.
      const initInfo = activeThread.initInfo ?? (() => {
        const project = useProjectStore.getState().projects.find(p => p.id === pid);
        const cwd = activeThread.worktreePath || project?.path || '';
        return { model: model || activeThread.model, cwd, tools: [] as string[] };
      })();

      const newMessage = {
        id: crypto.randomUUID(),
        threadId,
        role: 'user' as MessageRole,
        content,
        images,
        timestamp: new Date().toISOString(),
        model,
        permissionMode,
      };

      // Append message using concat (avoids spreading the entire messages array)
      const nextMessages = activeThread.messages.concat(newMessage);

      // Only rebuild threadsByProject if the status actually changed
      const statusChanged = newStatus !== activeThread.status;
      const nextThreadsByProject = statusChanged
        ? {
            ...threadsByProject,
            [pid]: projectThreads.map((t) =>
              t.id === threadId ? { ...t, status: newStatus } : t
            ),
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
    const existingIds = new Set(current.messages.map(m => m.id));
    const newMessages = olderMessages.filter(m => !existingIds.has(m.id));

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
    const resultInfo = activeThread.resultInfo
      ?? ((thread.status === 'completed' || thread.status === 'failed')
        ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0, error: (thread as any).error }
        : undefined);
    const threadEvents = eventsResult.isOk() ? eventsResult.value.events : activeThread.threadEvents;
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
        waitingReason: isServerWaiting ? activeThread.waitingReason : undefined,
        pendingPermission: isServerWaiting ? activeThread.pendingPermission : undefined,
      },
    });
  },

  refreshAllLoadedThreads: async () => {
    const { threadsByProject, loadThreadsForProject, refreshActiveThread } = get();
    const projectIds = Object.keys(threadsByProject);
    await Promise.all(projectIds.map((pid) => loadThreadsForProject(pid)));
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
}));
