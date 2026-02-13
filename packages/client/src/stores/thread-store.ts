/**
 * Thread store — Zustand store for thread state management.
 * Delegates WebSocket handling to thread-ws-handlers, state machine transitions
 * to thread-machine-bridge, and module-level coordination to thread-store-internals.
 */

import { create } from 'zustand';
import type { Thread, MessageRole, ThreadStatus, ThreadStage, WaitingReason, ClaudeModel, PermissionMode } from '@a-parallel/shared';
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
}

export interface ThreadWithMessages extends Thread {
  messages: (import('@a-parallel/shared').Message & { toolCalls?: any[] })[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string };
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
  appendOptimisticMessage: (threadId: string, content: string, images?: any[], model?: ClaudeModel, permissionMode?: PermissionMode) => void;
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
    }
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
    set({ selectedThreadId: threadId, activeThread: null });
    useUIStore.setState({ newThreadProjectId: null, allThreadsProjectId: null });

    if (!threadId) return;

    const result = await api.getThread(threadId);

    if (result.isErr()) {
      if (getSelectGeneration() === gen) {
        clearWSBuffer(threadId);
        set({ activeThread: null, selectedThreadId: null });
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
      ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0 }
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

    set({ activeThread: { ...thread, initInfo: buffered || undefined, resultInfo, waitingReason, pendingPermission } });
    useProjectStore.setState({ selectedProjectId: projectId });

    // Replay any WS events that arrived while activeThread was loading
    flushWSBuffer(threadId, get());
  },

  archiveThread: async (threadId, projectId) => {
    const result = await api.archiveThread(threadId, true);
    if (result.isErr()) return;
    cleanupThreadActor(threadId);
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
  },

  unarchiveThread: async (threadId, projectId, stage) => {
    const result = await api.archiveThread(threadId, false);
    if (result.isErr()) return;
    // Also update the stage
    await api.updateThreadStage(threadId, stage);
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, archived: false, stage } : t
        ),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, archived: false, stage } : activeThread,
    });
  },

  pinThread: async (threadId, projectId, pinned) => {
    const result = await api.pinThread(threadId, pinned);
    if (result.isErr()) return;
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, pinned } : t
        ),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, pinned } : activeThread,
    });
  },

  updateThreadStage: async (threadId, projectId, stage) => {
    const result = await api.updateThreadStage(threadId, stage);
    if (result.isErr()) return;
    const { threadsByProject, activeThread } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.map((t) =>
          t.id === threadId ? { ...t, stage } : t
        ),
      },
      activeThread: activeThread?.id === threadId ? { ...activeThread, stage } : activeThread,
    });
  },

  deleteThread: async (threadId, projectId) => {
    const result = await api.deleteThread(threadId);
    if (result.isErr()) return;
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
  },

  appendOptimisticMessage: (threadId, content, images, model, permissionMode) => {
    const { activeThread, threadsByProject } = get();
    if (activeThread?.id === threadId) {
      const pid = activeThread.projectId;
      const projectThreads = threadsByProject[pid] ?? [];

      const machineEvent = { type: 'START' as const };
      const newStatus = transitionThreadStatus(threadId, machineEvent, activeThread.status, activeThread.cost);

      set({
        activeThread: {
          ...activeThread,
          status: newStatus,
          waitingReason: undefined,
          pendingPermission: undefined,
          messages: [
            ...activeThread.messages,
            {
              id: crypto.randomUUID(),
              threadId,
              role: 'user' as MessageRole,
              content,
              images,
              timestamp: new Date().toISOString(),
              model,
              permissionMode,
            },
          ],
        },
        threadsByProject: {
          ...threadsByProject,
          [pid]: projectThreads.map((t) =>
            t.id === threadId ? { ...t, status: newStatus } : t
          ),
        },
      });
    }
  },

  refreshActiveThread: async () => {
    const { activeThread } = get();
    if (!activeThread) return;
    const result = await api.getThread(activeThread.id);
    if (result.isErr()) return; // silently ignore
    const thread = result.value;
    const resultInfo = activeThread.resultInfo
      ?? ((thread.status === 'completed' || thread.status === 'failed')
        ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0 }
        : undefined);
    set({ activeThread: { ...thread, initInfo: activeThread.initInfo, resultInfo } });
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
}));
