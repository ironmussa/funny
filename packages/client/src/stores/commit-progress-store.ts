import { create } from 'zustand';

import type { GitProgressStep } from '@/lib/git-progress-types';

export interface CommitProgressEntry {
  title: string;
  steps: GitProgressStep[];
  action: string;
  workflowId?: string;
}

interface FailedWorkflowEntry {
  title: string;
  steps: GitProgressStep[];
  action: string;
}

interface CommitProgressState {
  /** Active commit operations keyed by threadId (or projectModeId) */
  activeCommits: Record<string, CommitProgressEntry>;

  /**
   * Per threadId (or projectModeId), how many workflows have ended there and
   * the action of the last one. It changes on every end, including a workflow
   * that failed before it started (no entry ever existed), so the review pane
   * clears its in-progress flags on this, not on an entry disappearing — which
   * also happens when the pane switches to another thread.
   */
  settled: Record<string, { count: number; action: string }>;

  /** When a workflow fails, store it here so a modal can display the full error */
  failedWorkflow: FailedWorkflowEntry | null;

  startCommit: (
    id: string,
    title: string,
    steps: GitProgressStep[],
    action: string,
    workflowId?: string,
  ) => void;
  updateStep: (id: string, stepId: string, update: Partial<GitProgressStep>) => void;
  /**
   * Replace all steps at once (used by server-side workflow progress via WS).
   * With a `workflowId`, only when the entry is still that workflow: a late
   * update from a previous run must not overwrite the steps of a new one.
   */
  replaceSteps: (id: string, steps: GitProgressStep[], workflowId?: string) => void;
  /**
   * Remove the entry and mark the workflow ended (`settled`). With a
   * `workflowId`, only when the entry is still that workflow: a delayed close
   * must not drop a workflow restarted in between. Without an entry (the
   * workflow failed before it started) it only marks the end.
   */
  finishCommit: (id: string, workflowId?: string, action?: string) => void;
  /** Show a failed workflow in the error modal */
  setFailedWorkflow: (entry: FailedWorkflowEntry) => void;
  /** Dismiss the failed workflow modal */
  clearFailedWorkflow: () => void;
}

export const useCommitProgressStore = create<CommitProgressState>((set) => ({
  activeCommits: {},
  settled: {},
  failedWorkflow: null,

  startCommit: (id, title, steps, action, workflowId) =>
    set((state) => ({
      activeCommits: { ...state.activeCommits, [id]: { title, steps, action, workflowId } },
    })),

  updateStep: (id, stepId, update) =>
    set((state) => {
      const entry = state.activeCommits[id];
      if (!entry) return state;
      return {
        activeCommits: {
          ...state.activeCommits,
          [id]: {
            ...entry,
            steps: entry.steps.map((s) => (s.id === stepId ? { ...s, ...update } : s)),
          },
        },
      };
    }),

  replaceSteps: (id, steps, workflowId) =>
    set((state) => {
      const entry = state.activeCommits[id];
      if (!entry) return state;
      if (workflowId && entry.workflowId && entry.workflowId !== workflowId) return state;
      return {
        activeCommits: {
          ...state.activeCommits,
          [id]: { ...entry, steps },
        },
      };
    }),

  finishCommit: (id, workflowId, action) =>
    set((state) => {
      const entry = state.activeCommits[id];
      if (entry && workflowId && entry.workflowId && entry.workflowId !== workflowId) return state;
      const settled = {
        ...state.settled,
        [id]: {
          count: (state.settled[id]?.count ?? 0) + 1,
          action: entry?.action ?? action ?? '',
        },
      };
      if (!entry) return { settled };
      const { [id]: _, ...rest } = state.activeCommits;
      return { activeCommits: rest, settled };
    }),

  setFailedWorkflow: (entry) => set({ failedWorkflow: entry }),
  clearFailedWorkflow: () => set({ failedWorkflow: null }),
}));
