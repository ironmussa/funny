import type { Automation, AutomationRun, InboxItem } from '@funny/shared';
import { create } from 'zustand';

import { automationsApi as api } from '@/lib/api/automations';

interface AutomationState {
  automationsByProject: Record<string, Automation[]>;
  inbox: InboxItem[];
  inboxCount: number;
  selectedAutomationRuns: AutomationRun[];

  loadAutomations: (projectId: string) => Promise<void>;
  loadInbox: (options?: { projectId?: string; triageStatus?: string }) => Promise<void>;
  loadRuns: (automationId: string) => Promise<void>;
  createAutomation: (
    data: Parameters<typeof api.createAutomation>[0],
  ) => Promise<Automation | null>;
  updateAutomation: (id: string, data: Parameters<typeof api.updateAutomation>[1]) => Promise<void>;
  deleteAutomation: (id: string, projectId: string) => Promise<void>;
  triggerAutomation: (id: string) => Promise<void>;
  triageRun: (runId: string, status: 'reviewed' | 'dismissed') => Promise<void>;

  // WS handlers
  handleRunStarted: (data: { automationId: string; runId: string; threadId: string }) => void;
  handleRunCompleted: (data: { automationId: string; runId: string; hasFindings: boolean }) => void;
}

// Deduplicate concurrent loadInbox calls (WS events can fire in rapid succession)
let _inboxInFlight: Promise<void> | null = null;
const INBOX_COOLDOWN_MS = 2_000;
let _lastInboxFetch = 0;

export const useAutomationStore = create<AutomationState>((set, get) => ({
  automationsByProject: {},
  inbox: [],
  inboxCount: 0,
  selectedAutomationRuns: [],

  loadAutomations: async (projectId) => {
    const result = await api.listAutomations(projectId);
    result.match(
      (automations) => {
        set((state) => ({
          automationsByProject: { ...state.automationsByProject, [projectId]: automations },
        }));
      },
      (error) => console.error('[automation-store] Failed to load automations:', error.message),
    );
  },

  loadInbox: async (options?: { projectId?: string; triageStatus?: string }) => {
    // Coalesce rapid calls (e.g. handleRunStarted + handleRunCompleted firing together)
    const now = Date.now();
    if (now - _lastInboxFetch < INBOX_COOLDOWN_MS && _inboxInFlight) {
      return _inboxInFlight;
    }
    if (_inboxInFlight) return _inboxInFlight;
    _lastInboxFetch = now;

    _inboxInFlight = (async () => {
      try {
        const result = await api.getAutomationInbox(options);
        if (result.isOk()) {
          const inbox = result.value;
          const pendingCount = inbox.filter((item) => item.run.triageStatus === 'pending').length;
          set({ inbox, inboxCount: pendingCount });
        } else {
          console.error('[automation-store] Failed to load inbox:', result.error.message);
          throw result.error;
        }
      } finally {
        _inboxInFlight = null;
      }
    })();
    return _inboxInFlight;
  },

  loadRuns: async (automationId) => {
    const result = await api.listAutomationRuns(automationId);
    result.match(
      (runs) => set({ selectedAutomationRuns: runs }),
      (error) => console.error('[automation-store] Failed to load runs:', error.message),
    );
  },

  createAutomation: async (data) => {
    const result = await api.createAutomation(data);
    if (result.isErr()) return null;
    const automation = result.value;
    const projectId = data.projectId;
    set((state) => ({
      automationsByProject: {
        ...state.automationsByProject,
        [projectId]: [automation, ...(state.automationsByProject[projectId] || [])],
      },
    }));
    return automation;
  },

  updateAutomation: async (id, data) => {
    const result = await api.updateAutomation(id, data);
    if (result.isErr()) return;
    const updated = result.value;
    set((state) => {
      const newByProject = { ...state.automationsByProject };
      for (const [pid, automations] of Object.entries(newByProject)) {
        newByProject[pid] = automations.map((a) => (a.id === id ? updated : a));
      }
      return { automationsByProject: newByProject };
    });
  },

  deleteAutomation: async (id, projectId) => {
    const result = await api.deleteAutomation(id);
    if (result.isErr()) return;
    set((state) => ({
      automationsByProject: {
        ...state.automationsByProject,
        [projectId]: (state.automationsByProject[projectId] || []).filter((a) => a.id !== id),
      },
    }));
  },

  triggerAutomation: async (id) => {
    await api.triggerAutomation(id);
    // Result is fire-and-forget; error handling not needed
  },

  triageRun: async (runId, status) => {
    const result = await api.triageRun(runId, status);
    if (result.isErr()) return;
    set((state) => {
      const updatedInbox = state.inbox.map((item) =>
        item.run.id === runId ? { ...item, run: { ...item.run, triageStatus: status } } : item,
      );
      const pendingCount = updatedInbox.filter(
        (item) => item.run.triageStatus === 'pending',
      ).length;
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
