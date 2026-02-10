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

    try {
      const { statuses } = await api.getGitStatuses(projectId);
      const updates: Record<string, GitStatusInfo> = {};
      for (const s of statuses) {
        updates[s.threadId] = s;
      }
      set((state) => ({
        statusByThread: { ...state.statusByThread, ...updates },
      }));
    } catch {
      // Silently ignore — git status is best-effort
    } finally {
      set((s) => {
        const next = new Set(s.loadingProjects);
        next.delete(projectId);
        return { loadingProjects: next };
      });
    }
  },

  fetchForThread: async (threadId) => {
    try {
      const status = await api.getGitStatus(threadId);
      set((state) => ({
        statusByThread: { ...state.statusByThread, [threadId]: status },
      }));
    } catch {
      // Silently ignore
    }
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
