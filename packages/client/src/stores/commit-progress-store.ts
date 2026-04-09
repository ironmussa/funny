import { create } from 'zustand';

import type { GitProgressStep } from '@/components/GitProgressModal';

export interface CommitProgressEntry {
  title: string;
  steps: GitProgressStep[];
  action: string;
  workflowId?: string;
}

export interface FailedWorkflowEntry {
  title: string;
  steps: GitProgressStep[];
  action: string;
}

interface CommitProgressState {
  /** Active commit operations keyed by threadId (or projectModeId) */
  activeCommits: Record<string, CommitProgressEntry>;

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
  /** Replace all steps at once (used by server-side workflow progress via WS) */
  replaceSteps: (id: string, steps: GitProgressStep[]) => void;
  finishCommit: (id: string) => void;
  /** Show a failed workflow in the error modal */
  setFailedWorkflow: (entry: FailedWorkflowEntry) => void;
  /** Dismiss the failed workflow modal */
  clearFailedWorkflow: () => void;
}

export const useCommitProgressStore = create<CommitProgressState>((set) => ({
  activeCommits: {},
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

  replaceSteps: (id, steps) =>
    set((state) => {
      const entry = state.activeCommits[id];
      if (!entry) return state;
      return {
        activeCommits: {
          ...state.activeCommits,
          [id]: { ...entry, steps },
        },
      };
    }),

  finishCommit: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.activeCommits;
      return { activeCommits: rest };
    }),

  setFailedWorkflow: (entry) => set({ failedWorkflow: entry }),
  clearFailedWorkflow: () => set({ failedWorkflow: null }),
}));
