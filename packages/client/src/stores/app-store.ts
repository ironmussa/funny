import { create } from 'zustand';
import type { Project, Thread, Message } from '@a-parallel/shared';
import { api } from '@/lib/api';

interface AgentInitInfo {
  tools: string[];
  cwd: string;
  model: string;
}

interface AgentResultInfo {
  status: 'completed' | 'failed';
  cost: number;
  duration: number;
}

interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: any[] })[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
}

interface AppState {
  // Data
  projects: Project[];
  threadsByProject: Record<string, Thread[]>;
  activeThread: ThreadWithMessages | null;

  // UI state
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  expandedProjects: Set<string>;
  reviewPaneOpen: boolean;
  settingsOpen: boolean;
  activeSettingsPage: string | null;
  newThreadProjectId: string | null;

  // Actions
  loadProjects: () => Promise<void>;
  loadThreadsForProject: (projectId: string) => Promise<void>;
  toggleProject: (projectId: string) => void;
  selectProject: (projectId: string | null) => void;
  selectThread: (threadId: string | null) => Promise<void>;
  setReviewPaneOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSettingsPage: (page: string | null) => void;
  startNewThread: (projectId: string) => void;
  cancelNewThread: () => void;

  // Thread actions
  archiveThread: (threadId: string, projectId: string) => Promise<void>;
  appendOptimisticMessage: (threadId: string, content: string) => void;
  refreshActiveThread: () => Promise<void>;

  // WebSocket event handlers
  handleWSInit: (threadId: string, data: AgentInitInfo) => void;
  handleWSMessage: (threadId: string, data: { messageId?: string; role: string; content: string }) => void;
  handleWSToolCall: (threadId: string, data: { toolCallId?: string; messageId?: string; name: string; input: unknown }) => void;
  handleWSToolOutput: (threadId: string, data: { toolCallId: string; output: string }) => void;
  handleWSStatus: (threadId: string, data: { status: string }) => void;
  handleWSResult: (threadId: string, data: any) => void;
}

// Buffer init info that arrives before the thread is active
const initInfoBuffer = new Map<string, AgentInitInfo>();

export const useAppStore = create<AppState>((set, get) => ({
  // Data
  projects: [],
  threadsByProject: {},
  activeThread: null,

  // UI state
  selectedProjectId: null,
  selectedThreadId: null,
  expandedProjects: new Set(),
  reviewPaneOpen: false,
  settingsOpen: false,
  activeSettingsPage: null,
  newThreadProjectId: null,

  // Actions
  loadProjects: async () => {
    const projects = await api.listProjects();
    set({ projects });
  },

  loadThreadsForProject: async (projectId: string) => {
    const threads = await api.listThreads(projectId);
    set((state) => ({
      threadsByProject: { ...state.threadsByProject, [projectId]: threads },
    }));
  },

  toggleProject: (projectId: string) => {
    const { expandedProjects, threadsByProject, loadThreadsForProject } = get();
    const next = new Set(expandedProjects);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
      // Load threads if not loaded yet
      if (!threadsByProject[projectId]) {
        loadThreadsForProject(projectId);
      }
    }
    set({ expandedProjects: next });
  },

  selectProject: (projectId) => {
    if (!projectId) {
      set({ selectedProjectId: null });
      return;
    }
    const { expandedProjects, threadsByProject, loadThreadsForProject } = get();
    set({ selectedProjectId: projectId });
    if (!expandedProjects.has(projectId)) {
      const next = new Set(expandedProjects);
      next.add(projectId);
      set({ expandedProjects: next });
    }
    if (!threadsByProject[projectId]) {
      loadThreadsForProject(projectId);
    }
  },

  selectThread: async (threadId) => {
    set({ selectedThreadId: threadId, newThreadProjectId: null });
    if (!threadId) {
      set({ activeThread: null });
      return;
    }
    try {
      const thread = await api.getThread(threadId);
      const projectId = thread.projectId;
      const { expandedProjects, threadsByProject, loadThreadsForProject } = get();
      if (!expandedProjects.has(projectId)) {
        const next = new Set(expandedProjects);
        next.add(projectId);
        set({ expandedProjects: next });
      }
      if (!threadsByProject[projectId]) {
        loadThreadsForProject(projectId);
      }
      const buffered = initInfoBuffer.get(threadId);
      if (buffered) initInfoBuffer.delete(threadId);
      const resultInfo = (thread.status === 'completed' || thread.status === 'failed')
        ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0 }
        : undefined;
      set({ activeThread: { ...thread, initInfo: buffered || undefined, resultInfo }, selectedProjectId: projectId });
    } catch {
      set({ activeThread: null, selectedThreadId: null });
    }
  },

  setReviewPaneOpen: (open) => set({ reviewPaneOpen: open }),
  setSettingsOpen: (open) => set(open ? { settingsOpen: true } : { settingsOpen: false, activeSettingsPage: null }),
  setActiveSettingsPage: (page) => set({ activeSettingsPage: page }),
  startNewThread: (projectId: string) => {
    set({ newThreadProjectId: projectId, selectedProjectId: projectId, selectedThreadId: null, activeThread: null });
  },

  cancelNewThread: () => {
    set({ newThreadProjectId: null });
  },

  archiveThread: async (threadId, projectId) => {
    await api.archiveThread(threadId, true);
    const { threadsByProject, selectedThreadId } = get();
    const projectThreads = threadsByProject[projectId] ?? [];
    set({
      threadsByProject: {
        ...threadsByProject,
        [projectId]: projectThreads.filter((t) => t.id !== threadId),
      },
    });
    if (selectedThreadId === threadId) {
      set({ selectedThreadId: null, activeThread: null, selectedProjectId: null });
    }
  },

  appendOptimisticMessage: (threadId, content) => {
    const { activeThread, threadsByProject } = get();
    if (activeThread?.id === threadId) {
      const pid = activeThread.projectId;
      const projectThreads = threadsByProject[pid] ?? [];
      set({
        activeThread: {
          ...activeThread,
          status: 'running',
          messages: [
            ...activeThread.messages,
            {
              id: crypto.randomUUID(),
              threadId,
              role: 'user' as any,
              content,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        threadsByProject: {
          ...threadsByProject,
          [pid]: projectThreads.map((t) =>
            t.id === threadId ? { ...t, status: 'running' as any } : t
          ),
        },
      });
    }
  },

  refreshActiveThread: async () => {
    const { activeThread } = get();
    if (!activeThread) return;
    try {
      const thread = await api.getThread(activeThread.id);
      const resultInfo = activeThread.resultInfo
        ?? ((thread.status === 'completed' || thread.status === 'failed')
          ? { status: thread.status as 'completed' | 'failed', cost: thread.cost, duration: 0 }
          : undefined);
      set({ activeThread: { ...thread, initInfo: activeThread.initInfo, resultInfo } });
    } catch {
      // silently ignore
    }
  },

  // WebSocket event handlers — update in-memory state without refetching
  handleWSInit: (threadId, data) => {
    const { activeThread } = get();
    if (activeThread?.id === threadId) {
      set({ activeThread: { ...activeThread, initInfo: data } });
    } else {
      // Thread not active yet — buffer for when it loads
      initInfoBuffer.set(threadId, data);
    }
  },

  handleWSMessage: (threadId, data) => {
    const { activeThread } = get();

    if (activeThread?.id === threadId) {
      const messageId = data.messageId;

      if (messageId) {
        const existingIdx = activeThread.messages.findIndex((m) => m.id === messageId);
        if (existingIdx >= 0) {
          const updated = [...activeThread.messages];
          updated[existingIdx] = { ...updated[existingIdx], content: data.content };
          set({ activeThread: { ...activeThread, messages: updated } });
          return;
        }
      }

      set({
        activeThread: {
          ...activeThread,
          messages: [
            ...activeThread.messages,
            {
              id: messageId || crypto.randomUUID(),
              threadId,
              role: data.role as any,
              content: data.content,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      });
    }
  },

  handleWSToolCall: (threadId, data) => {
    const { activeThread } = get();

    if (activeThread?.id === threadId) {
      const toolCallId = data.toolCallId || crypto.randomUUID();

      const messages = [...activeThread.messages];
      const tcEntry = { id: toolCallId, messageId: data.messageId || '', name: data.name, input: JSON.stringify(data.input) };

      // If server provided messageId, find that exact message
      if (data.messageId) {
        const msgIdx = messages.findIndex((m) => m.id === data.messageId);
        if (msgIdx >= 0) {
          const msg = messages[msgIdx];
          // Skip if this tool call already exists (race between API fetch and WS)
          if (msg.toolCalls?.some((tc: any) => tc.id === toolCallId)) return;
          messages[msgIdx] = {
            ...msg,
            toolCalls: [...(msg.toolCalls ?? []), tcEntry],
          };
          set({ activeThread: { ...activeThread, messages } });
          return;
        }
      }

      // Message not found — create a new placeholder assistant message
      // Never attach to random old messages to avoid misplacement
      set({
        activeThread: {
          ...activeThread,
          messages: [
            ...messages,
            {
              id: data.messageId || crypto.randomUUID(),
              threadId,
              role: 'assistant' as any,
              content: '',
              timestamp: new Date().toISOString(),
              toolCalls: [tcEntry],
            },
          ],
        },
      });
    }
  },

  handleWSToolOutput: (threadId, data) => {
    const { activeThread } = get();
    if (activeThread?.id !== threadId) return;

    const messages = activeThread.messages.map((msg) => {
      if (!msg.toolCalls) return msg;
      const updatedTCs = msg.toolCalls.map((tc: any) =>
        tc.id === data.toolCallId ? { ...tc, output: data.output } : tc
      );
      return { ...msg, toolCalls: updatedTCs };
    });

    set({ activeThread: { ...activeThread, messages } });
  },

  handleWSStatus: (threadId, data) => {
    const { threadsByProject, activeThread } = get();

    const updated: Record<string, Thread[]> = {};
    for (const [pid, threads] of Object.entries(threadsByProject)) {
      updated[pid] = threads.map((t) =>
        t.id === threadId ? { ...t, status: data.status as any } : t
      );
    }
    set({ threadsByProject: { ...threadsByProject, ...updated } });

    if (activeThread?.id === threadId) {
      set({ activeThread: { ...activeThread, status: data.status as any } });
    }
  },

  handleWSResult: (threadId, data) => {
    const { threadsByProject, activeThread } = get();
    const resultStatus = data.status ?? 'completed';

    const updated: Record<string, Thread[]> = {};
    for (const [pid, threads] of Object.entries(threadsByProject)) {
      updated[pid] = threads.map((t) =>
        t.id === threadId
          ? { ...t, status: resultStatus as any, cost: data.cost ?? t.cost }
          : t
      );
    }
    set({ threadsByProject: { ...threadsByProject, ...updated } });

    if (activeThread?.id === threadId) {
      set({
        activeThread: {
          ...activeThread,
          status: resultStatus,
          cost: data.cost ?? activeThread.cost,
          resultInfo: {
            status: resultStatus as 'completed' | 'failed',
            cost: data.cost ?? activeThread.cost,
            duration: data.duration ?? 0,
          },
        },
      });
    }
  },
}));
