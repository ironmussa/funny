import { create } from 'zustand';
import type { GitStatusInfo } from '@a-parallel/shared';
import { api } from '@/lib/api';

interface GitStatusState {
  statusByThread: Record<string, GitStatusInfo>;
  loadingProjects: Set<string>;

  fetchForProject: (projectId: string) => Promise<void>;
  fetchForThread: (threadId: string) => Promise<void>;
  updateFromWS: (statuses: GitStatusInfo[]) => void;
  clearForThread: (threadId: string) => void;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statusByThread: {},
  loadingProjects: new Set(),

  fetchForProject: async (projectId) => {
    if (get().loadingProjects.has(projectId)) return;
    set((s) => ({ loadingProjects: new Set([...s.loadingProjects, projectId]) }));

    const result = await api.getGitStatuses(projectId);
    if (result.isOk()) {
      const updates: Record<string, GitStatusInfo> = {};
      for (const s of result.value.statuses) {
        updates[s.threadId] = s;
      }
      set((state) => ({
        statusByThread: { ...state.statusByThread, ...updates },
      }));
    }
    // Silently ignore errors — git status is best-effort
    set((s) => {
      const next = new Set(s.loadingProjects);
      next.delete(projectId);
      return { loadingProjects: next };
    });
  },

  fetchForThread: async (threadId) => {
    const result = await api.getGitStatus(threadId);
    if (result.isOk()) {
      set((state) => ({
        statusByThread: { ...state.statusByThread, [threadId]: result.value },
      }));
    }
    // Silently ignore errors
  },

  updateFromWS: (statuses) => {
    const updates: Record<string, GitStatusInfo> = {};
    for (const s of statuses) {
      updates[s.threadId] = s;
    }
    set((state) => ({
      statusByThread: { ...state.statusByThread, ...updates },
    }));
  },

  clearForThread: (threadId) => {
    set((state) => {
      const next = { ...state.statusByThread };
      delete next[threadId];
      return { statusByThread: next };
    });
  },
}));
