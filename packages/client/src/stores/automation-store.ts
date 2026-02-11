import { create } from 'zustand';
import type { Automation, AutomationRun, InboxItem } from '@a-parallel/shared';
import { api } from '@/lib/api';

interface AutomationState {
  automationsByProject: Record<string, Automation[]>;
  inbox: InboxItem[];
  inboxCount: number;
  selectedAutomationRuns: AutomationRun[];

  loadAutomations: (projectId: string) => Promise<void>;
  loadInbox: (options?: { projectId?: string; triageStatus?: string }) => Promise<void>;
  loadRuns: (automationId: string) => Promise<void>;
  createAutomation: (data: Parameters<typeof api.createAutomation>[0]) => Promise<Automation>;
  updateAutomation: (id: string, data: Parameters<typeof api.updateAutomation>[1]) => Promise<void>;
  deleteAutomation: (id: string, projectId: string) => Promise<void>;
  triggerAutomation: (id: string) => Promise<void>;
  triageRun: (runId: string, status: 'reviewed' | 'dismissed') => Promise<void>;

  // WS handlers
  handleRunStarted: (data: { automationId: string; runId: string; threadId: string }) => void;
  handleRunCompleted: (data: { automationId: string; runId: string; hasFindings: boolean }) => void;
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  automationsByProject: {},
  inbox: [],
  inboxCount: 0,
  selectedAutomationRuns: [],

  loadAutomations: async (projectId) => {
    try {
      const automations = await api.listAutomations(projectId);
      set(state => ({
        automationsByProject: { ...state.automationsByProject, [projectId]: automations },
      }));
    } catch (e) {
      console.error('[automation-store] Failed to load automations:', e);
    }
  },

  loadInbox: async (options?: { projectId?: string; triageStatus?: string }) => {
    try {
      const inbox = await api.getAutomationInbox(options);
      const pendingCount = inbox.filter(item => item.run.triageStatus === 'pending').length;
      set({ inbox, inboxCount: pendingCount });
    } catch (e) {
      console.error('[automation-store] Failed to load inbox:', e);
    }
  },

  loadRuns: async (automationId) => {
    try {
      const runs = await api.listAutomationRuns(automationId);
      set({ selectedAutomationRuns: runs });
    } catch (e) {
      console.error('[automation-store] Failed to load runs:', e);
    }
  },

  createAutomation: async (data) => {
    const automation = await api.createAutomation(data);
    const projectId = data.projectId;
    set(state => ({
      automationsByProject: {
        ...state.automationsByProject,
        [projectId]: [automation, ...(state.automationsByProject[projectId] || [])],
      },
    }));
    return automation;
  },

  updateAutomation: async (id, data) => {
    const updated = await api.updateAutomation(id, data);
    set(state => {
      const newByProject = { ...state.automationsByProject };
      for (const [pid, automations] of Object.entries(newByProject)) {
        newByProject[pid] = automations.map(a => a.id === id ? updated : a);
      }
      return { automationsByProject: newByProject };
    });
  },

  deleteAutomation: async (id, projectId) => {
    await api.deleteAutomation(id);
    set(state => ({
      automationsByProject: {
        ...state.automationsByProject,
        [projectId]: (state.automationsByProject[projectId] || []).filter(a => a.id !== id),
      },
    }));
  },

  triggerAutomation: async (id) => {
    await api.triggerAutomation(id);
  },

  triageRun: async (runId, status) => {
    await api.triageRun(runId, status);
    set(state => {
      const updatedInbox = state.inbox.map(item =>
        item.run.id === runId
          ? { ...item, run: { ...item.run, triageStatus: status } }
          : item
      );
      const pendingCount = updatedInbox.filter(item => item.run.triageStatus === 'pending').length;
      return { inbox: updatedInbox, inboxCount: pendingCount };
    });
  },

  handleRunStarted: (_data) => {
    get().loadInbox();
  },

  handleRunCompleted: (data) => {
    get().loadInbox();
    // Refresh runs if viewing this automation's runs
    const currentRuns = get().selectedAutomationRuns;
    if (currentRuns.length > 0 && currentRuns[0].automationId === data.automationId) {
      get().loadRuns(data.automationId);
    }
  },
}));
