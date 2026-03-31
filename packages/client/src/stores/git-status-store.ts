import type { GitStatusInfo } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';
import { useThreadStore } from '@/stores/thread-store';

/** Git status for a project root (no threadId) */
export type ProjectGitStatus = Omit<GitStatusInfo, 'threadId' | 'branchKey'>;

/**
 * Compute a stable cache key that groups threads sharing the same git working state.
 * Matches the server-side `computeBranchKey` logic.
 */
export function branchKey(thread: {
  id: string;
  projectId: string;
  mode?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
}): string {
  // Worktree threads: always unique per thread — each worktree has its own
  // working directory so even threads on the same branch have independent state.
  // Use `mode` as the primary signal (worktreePath may be null if the worktree
  // was cleaned up but the thread hasn't been archived yet).
  if (thread.mode === 'worktree' && thread.branch)
    return `wt:${thread.projectId}:${thread.branch}:${thread.id}`;
  // Local threads with a branch: group by project + branch (they share the project cwd)
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  // Local threads without a branch: group by project.
  // This covers both active local threads (branch=null) and merged threads —
  // the server resolves the correct branchKey per thread and the client picks
  // it up from the server response via threadToBranchKey mapping.
  return thread.projectId;
}

interface GitStatusState {
  /** Git status keyed by branchKey (threads sharing a branch share one entry) */
  statusByBranch: Record<string, GitStatusInfo>;
  /** Reverse lookup: threadId → branchKey (populated from API responses) */
  threadToBranchKey: Record<string, string>;
  statusByProject: Record<string, ProjectGitStatus>;
  loadingProjects: Set<string>;
  _loadingBranchKeys: Set<string>;
  _loadingProjectStatus: Set<string>;

  fetchForProject: (projectId: string) => Promise<void>;
  fetchForThread: (threadId: string, force?: boolean) => Promise<void>;
  fetchProjectStatus: (projectId: string, force?: boolean) => Promise<void>;
  /** Batch-ensure git status for a list of threads, deduplicating by branchKey. */
  ensureStatusForThreads: (
    threads: Array<{
      id: string;
      projectId: string;
      mode?: string | null;
      branch?: string | null;
      worktreePath?: string | null;
      baseBranch?: string | null;
    }>,
  ) => void;
  updateFromWS: (statuses: GitStatusInfo[]) => void;
  clearForBranch: (bk: string) => void;
}

const FETCH_COOLDOWN_MS = 5_000;
const BRANCH_FETCH_COOLDOWN_MS = 5_000;
const PROJECT_STATUS_COOLDOWN_MS = 5_000;
const _lastFetchByProject = new Map<string, number>();
const _lastFetchByBranch = new Map<string, number>();
const _lastFetchByProjectStatus = new Map<string, number>();

// ── Abort controllers ────────────────────────────────────────
// Cancel stale in-flight requests when a new fetch for the same key starts.
// This prevents pileup of long-running git status requests (avg 5s) that
// block the browser's connection pool and delay interactive requests.
const _abortByProject = new Map<string, AbortController>();
const _abortByBranch = new Map<string, AbortController>();
const _abortByProjectStatus = new Map<string, AbortController>();

/** @internal Clear cooldown map — only for tests */
export function _resetCooldowns() {
  _lastFetchByProject.clear();
  _lastFetchByBranch.clear();
  _lastFetchByProjectStatus.clear();
  for (const ac of _abortByProject.values()) ac.abort();
  _abortByProject.clear();
  for (const ac of _abortByBranch.values()) ac.abort();
  _abortByBranch.clear();
  for (const ac of _abortByProjectStatus.values()) ac.abort();
  _abortByProjectStatus.clear();
}

/**
 * Invalidate cooldowns for specific branchKeys so the next fetch is not throttled.
 * Called when a WebSocket git:status event delivers fresh data — the server already
 * computed fresh status, so the next user-triggered fetch should go through immediately.
 */
export function invalidateCooldownsForKeys(branchKeys: string[]) {
  for (const bk of branchKeys) {
    _lastFetchByBranch.delete(bk);
    // Also clear project cooldowns when a branch in that project was updated.
    // branchKey format is "projectId:branch" or just "projectId" for local threads.
    const projectId = bk.split(':')[0];
    if (projectId) {
      _lastFetchByProject.delete(projectId);
      _lastFetchByProjectStatus.delete(projectId);
    }
  }
}

/**
 * Resolve branchKey for a thread: check the server-provided mapping first,
 * then fall back to computing client-side from thread data in the thread store.
 * This ensures threads sharing a branch share cooldowns from the very first call.
 */
function resolveBranchKey(threadId: string, mapping: Record<string, string>): string | undefined {
  const fromMapping = mapping[threadId];
  if (fromMapping) return fromMapping;
  // Compute client-side from thread data
  const { threadsByProject } = useThreadStore.getState();
  for (const threads of Object.values(threadsByProject)) {
    const thread = threads.find((t) => t.id === threadId);
    if (thread) return branchKey(thread);
  }
  return undefined;
}

/** Compare two GitStatusInfo objects for equality on the fields that affect rendering */
function statusEqual(a: GitStatusInfo, b: GitStatusInfo): boolean {
  return (
    a.state === b.state &&
    a.dirtyFileCount === b.dirtyFileCount &&
    a.unpushedCommitCount === b.unpushedCommitCount &&
    a.unpulledCommitCount === b.unpulledCommitCount &&
    a.hasRemoteBranch === b.hasRemoteBranch &&
    a.isMergedIntoBase === b.isMergedIntoBase &&
    a.linesAdded === b.linesAdded &&
    a.linesDeleted === b.linesDeleted &&
    a.prNumber === b.prNumber &&
    a.prState === b.prState
  );
}

/** Only spread statusByBranch when at least one entry actually changed.
 *  Preserves existing object references for entries that haven't changed
 *  so downstream selectors and memo comparators can use `===`. */
function mergeStatuses(
  state: Pick<GitStatusState, 'statusByBranch'>,
  updates: Record<string, GitStatusInfo>,
): { statusByBranch: Record<string, GitStatusInfo> } | Record<string, never> {
  let changed = false;
  for (const [bk, next] of Object.entries(updates)) {
    const prev = state.statusByBranch[bk];
    if (!prev || !statusEqual(prev, next)) {
      changed = true;
      break;
    }
  }
  if (!changed) return {};
  // Build merged result, keeping old references for entries that didn't change
  const merged = { ...state.statusByBranch };
  for (const [bk, next] of Object.entries(updates)) {
    const prev = merged[bk];
    if (!prev || !statusEqual(prev, next)) {
      merged[bk] = next;
    }
    // else: keep prev reference (statusEqual was true)
  }
  return { statusByBranch: merged };
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statusByBranch: {},
  threadToBranchKey: {},
  statusByProject: {},
  loadingProjects: new Set(),
  _loadingBranchKeys: new Set(),
  _loadingProjectStatus: new Set(),

  fetchForProject: async (projectId) => {
    // Skip if fetched recently (prevents duplicate calls during cascading state updates)
    const now = Date.now();
    const lastFetch = _lastFetchByProject.get(projectId) ?? 0;
    if (now - lastFetch < FETCH_COOLDOWN_MS) {
      return;
    }
    _lastFetchByProject.set(projectId, now);

    // Abort any stale in-flight request for this project
    _abortByProject.get(projectId)?.abort();
    const ac = new AbortController();
    _abortByProject.set(projectId, ac);

    set((s) => {
      if (s.loadingProjects.has(projectId)) return {};
      const next = new Set(s.loadingProjects);
      next.add(projectId);
      return { loadingProjects: next };
    });

    try {
      const result = await api.getGitStatuses(projectId, ac.signal);
      if (result.isOk()) {
        const statuses = result.value.statuses;
        const updates: Record<string, GitStatusInfo> = {};
        const keyMap: Record<string, string> = {};
        for (const s of statuses) {
          updates[s.branchKey] = s;
          keyMap[s.threadId] = s.branchKey;
        }
        set((state) => {
          const statusPatch = mergeStatuses(state, updates);
          let keyMapChanged = false;
          for (const [tid, bk] of Object.entries(keyMap)) {
            if (state.threadToBranchKey[tid] !== bk) {
              keyMapChanged = true;
              break;
            }
          }
          if (!Object.keys(statusPatch).length && !keyMapChanged) return {};
          return {
            ...statusPatch,
            ...(keyMapChanged
              ? { threadToBranchKey: { ...state.threadToBranchKey, ...keyMap } }
              : {}),
          };
        });
      }
    } finally {
      _abortByProject.delete(projectId);
      // Silently ignore errors — git status is best-effort
      set((s) => {
        if (!s.loadingProjects.has(projectId)) return {};
        const next = new Set(s.loadingProjects);
        next.delete(projectId);
        return { loadingProjects: next };
      });
    }
  },

  fetchForThread: async (threadId, force) => {
    // Resolve branchKey from server mapping or compute client-side from thread data.
    // This ensures threads sharing a branch share the same cooldown key.
    const bk = resolveBranchKey(threadId, get().threadToBranchKey);
    const pendingKey = `pending:${threadId}`;
    const cooldownKey = bk || pendingKey;

    // Skip if fetched recently (shared cooldown per branch).
    // Check both the resolved key and the pending key to prevent duplicates
    // when the branchKey becomes known mid-flight (race between pending and resolved).
    const now = Date.now();
    if (!force) {
      if (bk && get()._loadingBranchKeys.has(bk)) {
        return;
      }
      const lastFetch = Math.max(
        _lastFetchByBranch.get(cooldownKey) ?? 0,
        bk ? (_lastFetchByBranch.get(pendingKey) ?? 0) : 0,
      );
      if (now - lastFetch < BRANCH_FETCH_COOLDOWN_MS) {
        return;
      }
    }
    _lastFetchByBranch.set(cooldownKey, now);
    // Also stamp the pending key so a concurrent call using the other key sees the cooldown
    if (bk) _lastFetchByBranch.set(pendingKey, now);

    // Abort any stale in-flight request for this thread/branch
    _abortByBranch.get(cooldownKey)?.abort();
    const ac = new AbortController();
    _abortByBranch.set(cooldownKey, ac);

    if (bk) {
      set((s) => {
        if (s._loadingBranchKeys.has(bk)) return {};
        const next = new Set(s._loadingBranchKeys);
        next.add(bk);
        return { _loadingBranchKeys: next };
      });
    }
    try {
      const result = await api.getGitStatus(threadId, ac.signal);
      if (result.isOk()) {
        const status = result.value;
        const key = status.branchKey;
        // Update cooldown with the real branchKey + pending key so concurrent
        // callers using either key are correctly deduped
        _lastFetchByBranch.set(key, now);
        _lastFetchByBranch.set(pendingKey, now);
        set((state) => {
          const statusPatch = mergeStatuses(state, { [key]: status });
          const keyChanged = state.threadToBranchKey[threadId] !== key;
          if (!Object.keys(statusPatch).length && !keyChanged) return {};
          return {
            ...statusPatch,
            ...(keyChanged
              ? { threadToBranchKey: { ...state.threadToBranchKey, [threadId]: key } }
              : {}),
          };
        });
      }
    } finally {
      _abortByBranch.delete(cooldownKey);
      if (bk) {
        set((s) => {
          if (!s._loadingBranchKeys.has(bk)) return {};
          const next = new Set(s._loadingBranchKeys);
          next.delete(bk);
          return { _loadingBranchKeys: next };
        });
      }
    }
  },

  fetchProjectStatus: async (projectId, force) => {
    const now = Date.now();
    if (!force) {
      if (get()._loadingProjectStatus.has(projectId)) return;
      const lastFetch = _lastFetchByProjectStatus.get(projectId) ?? 0;
      if (now - lastFetch < PROJECT_STATUS_COOLDOWN_MS) return;
    }
    _lastFetchByProjectStatus.set(projectId, now);

    // Abort any stale in-flight request for this project status
    _abortByProjectStatus.get(projectId)?.abort();
    const ac = new AbortController();
    _abortByProjectStatus.set(projectId, ac);

    set((s) => {
      if (s._loadingProjectStatus.has(projectId)) return {};
      const next = new Set(s._loadingProjectStatus);
      next.add(projectId);
      return { _loadingProjectStatus: next };
    });
    try {
      const result = await api.projectGitStatus(projectId, ac.signal);
      if (result.isOk()) {
        set((s) => ({ statusByProject: { ...s.statusByProject, [projectId]: result.value } }));
      }
    } finally {
      _abortByProjectStatus.delete(projectId);
      set((s) => {
        if (!s._loadingProjectStatus.has(projectId)) return {};
        const next = new Set(s._loadingProjectStatus);
        next.delete(projectId);
        return { _loadingProjectStatus: next };
      });
    }
  },

  ensureStatusForThreads: (threads) => {
    const { statusByBranch } = get();
    const seenBranches = new Set<string>();
    for (const thread of threads) {
      const bk = branchKey(thread);
      if (!statusByBranch[bk] && !seenBranches.has(bk)) {
        seenBranches.add(bk);
        get().fetchForThread(thread.id);
      }
    }
  },

  updateFromWS: (statuses) => {
    const updates: Record<string, GitStatusInfo> = {};
    const keyMap: Record<string, string> = {};
    for (const s of statuses) {
      updates[s.branchKey] = s;
      keyMap[s.threadId] = s.branchKey;
    }
    set((state) => {
      const statusPatch = mergeStatuses(state, updates);
      // Only spread threadToBranchKey if new mappings differ from existing ones
      let keyMapChanged = false;
      for (const [tid, bk] of Object.entries(keyMap)) {
        if (state.threadToBranchKey[tid] !== bk) {
          keyMapChanged = true;
          break;
        }
      }
      if (!Object.keys(statusPatch).length && !keyMapChanged) return {};
      return {
        ...statusPatch,
        ...(keyMapChanged ? { threadToBranchKey: { ...state.threadToBranchKey, ...keyMap } } : {}),
      };
    });
  },

  clearForBranch: (bk) => {
    set((state) => {
      const next = { ...state.statusByBranch };
      delete next[bk];
      return { statusByBranch: next };
    });
  },
}));

/**
 * Hook to get git status for a specific thread.
 * Resolves threadId → branchKey → status, falling back to client-side
 * branchKey computation so sibling threads on the same branch can
 * immediately display cached status without waiting for their own fetch.
 */
export function useGitStatusForThread(threadId: string | undefined): GitStatusInfo | undefined {
  return useGitStatusStore((state) => {
    if (!threadId) return undefined;
    const bk = resolveBranchKey(threadId, state.threadToBranchKey);
    return bk ? state.statusByBranch[bk] : undefined;
  });
}
