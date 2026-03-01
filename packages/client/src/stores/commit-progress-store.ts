import { create } from 'zustand';

import type { GitProgressStep } from '@/components/GitProgressModal';

export interface CommitProgressEntry {
  title: string;
  steps: GitProgressStep[];
  action: string;
}

interface CommitProgressState {
  /** Active commit operations keyed by threadId (or projectModeId) */
  activeCommits: Record<string, CommitProgressEntry>;

  startCommit: (id: string, title: string, steps: GitProgressStep[], action: string) => void;
  updateStep: (id: string, stepId: string, update: Partial<GitProgressStep>) => void;
  finishCommit: (id: string) => void;
}

export const useCommitProgressStore = create<CommitProgressState>((set) => ({
  activeCommits: {},

  startCommit: (id, title, steps, action) =>
    set((state) => ({
      activeCommits: { ...state.activeCommits, [id]: { title, steps, action } },
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

  finishCommit: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.activeCommits;
      return { activeCommits: rest };
    }),
}));
