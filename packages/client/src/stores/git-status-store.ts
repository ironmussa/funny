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

/** @internal Clear cooldown map — only for tests */
export function _resetCooldowns() {
  _lastFetchByProject.clear();
}

/** Compare two GitStatusInfo objects for equality on the fields that affect rendering */
function statusEqual(a: GitStatusInfo, b: GitStatusInfo): boolean {
  return a.state === b.state
    && a.dirtyFileCount === b.dirtyFileCount
    && a.unpushedCommitCount === b.unpushedCommitCount
    && a.hasRemoteBranch === b.hasRemoteBranch
    && a.isMergedIntoBase === b.isMergedIntoBase
    && a.linesAdded === b.linesAdded
    && a.linesDeleted === b.linesDeleted;
}

/** Only spread statusByThread when at least one entry actually changed */
function mergeStatuses(
  state: Pick<GitStatusState, 'statusByThread'>,
  updates: Record<string, GitStatusInfo>,
): { statusByThread: Record<string, GitStatusInfo> } | Record<string, never> {
  let changed = false;
  for (const [tid, next] of Object.entries(updates)) {
    const prev = state.statusByThread[tid];
    if (!prev || !statusEqual(prev, next)) {
      changed = true;
      break;
    }
  }
  if (!changed) return {};
  return { statusByThread: { ...state.statusByThread, ...updates } };
}

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
      set((state) => mergeStatuses(state, updates));
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
        set((state) => mergeStatuses(state, { [threadId]: result.value }));
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
    set((state) => mergeStatuses(state, updates));
  },

  clearForThread: (threadId) => {
    set((state) => {
      const next = { ...state.statusByThread };
      delete next[threadId];
      return { statusByThread: next };
    });
  },
}));
