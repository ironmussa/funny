import { create } from 'zustand';
import type { GitStatusInfo } from '@funny/shared';
import { api } from '@/lib/api';

interface GitStatusState {
  statusByThread: Record<string, GitStatusInfo>;
  loadingProjects: Set<string>;
  _loadingThreads: Set<string>;

  fetchForProject: (projectId: string) => Promise<void>;
  fetchForThread: (threadId: string) => Promise<void>;
  updateFromWS: (statuses: GitStatusInfo[]) => void;
  clearForThread: (threadId: string) => void;
}

const FETCH_COOLDOWN_MS = 5_000;
const _lastFetchByProject = new Map<string, number>();

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statusByThread: {},
  loadingProjects: new Set(),
  _loadingThreads: new Set(),

  fetchForProject: async (projectId) => {
    if (get().loadingProjects.has(projectId)) return;
    // Skip if fetched recently (prevents duplicate calls during cascading state updates)
    const now = Date.now();
    const lastFetch = _lastFetchByProject.get(projectId) ?? 0;
    if (now - lastFetch < FETCH_COOLDOWN_MS) return;
    _lastFetchByProject.set(projectId, now);
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
    if (get()._loadingThreads.has(threadId)) return;
    set((s) => ({ _loadingThreads: new Set([...s._loadingThreads, threadId]) }));
    try {
      const result = await api.getGitStatus(threadId);
      if (result.isOk()) {
        set((state) => ({
          statusByThread: { ...state.statusByThread, [threadId]: result.value },
        }));
      }
    } finally {
      set((s) => {
        const next = new Set(s._loadingThreads);
        next.delete(threadId);
        return { _loadingThreads: next };
      });
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
