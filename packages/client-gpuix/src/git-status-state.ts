import { createStore, type StoreApi } from '@funny/client-core';
import type { GitStatusInfo, Thread } from '@funny/shared';

export interface NativeGitStatusState {
  byThreadId: Record<string, GitStatusInfo>;
  byBranchKey: Record<string, GitStatusInfo>;
  threadToBranchKey: Record<string, string>;
  replace(statuses: readonly GitStatusInfo[]): void;
  clear(): void;
}

type GitStatusThread = Pick<Thread, 'id' | 'projectId' | 'mode' | 'branch'>;

export function nativeGitBranchKey(thread: GitStatusThread): string | null {
  if (!thread.projectId) return null;
  if (thread.mode === 'worktree' && thread.branch)
    return `wt:${thread.projectId}:${thread.branch}:${thread.id}`;
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  return thread.projectId;
}

export function nativeGitStatusForThread(
  state: Pick<NativeGitStatusState, 'byThreadId' | 'byBranchKey' | 'threadToBranchKey'>,
  thread: GitStatusThread,
): GitStatusInfo | undefined {
  const branchKey = state.threadToBranchKey[thread.id] ?? nativeGitBranchKey(thread);
  return (branchKey ? state.byBranchKey[branchKey] : undefined) ?? state.byThreadId[thread.id];
}

export function createNativeGitStatusStore(): StoreApi<NativeGitStatusState> {
  return createStore<NativeGitStatusState>((set) => ({
    byThreadId: {},
    byBranchKey: {},
    threadToBranchKey: {},
    replace(statuses) {
      set((state) => {
        const byThreadId = { ...state.byThreadId };
        const byBranchKey = { ...state.byBranchKey };
        const threadToBranchKey = { ...state.threadToBranchKey };
        for (const status of statuses) {
          byThreadId[status.threadId] = status;
          byBranchKey[status.branchKey] = status;
          threadToBranchKey[status.threadId] = status.branchKey;
        }
        return { byThreadId, byBranchKey, threadToBranchKey };
      });
    },
    clear() {
      set({ byThreadId: {}, byBranchKey: {}, threadToBranchKey: {} });
    },
  }));
}
