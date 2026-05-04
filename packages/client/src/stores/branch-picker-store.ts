import { create } from 'zustand';

import { projectsApi as api } from '@/lib/api/projects';

interface BranchPickerState {
  // ── Branch data ──
  branches: string[];
  remoteBranches: string[];
  defaultBranch: string | null;
  loading: boolean;
  selectedBranch: string;
  currentBranch: string | null;

  // ── Tracked project ──
  projectId: string | null;

  // ── Actions ──
  fetchBranches: (projectId: string, projectDefaultBranch?: string | null) => Promise<void>;
  setSelectedBranch: (branch: string) => void;
  setCurrentBranch: (branch: string) => void;
  invalidate: () => void;
  reset: () => void;
}

const initialState = {
  branches: [] as string[],
  remoteBranches: [] as string[],
  defaultBranch: null as string | null,
  loading: false,
  selectedBranch: '',
  currentBranch: null as string | null,
  projectId: null as string | null,
};

export const useBranchPickerStore = create<BranchPickerState>((set, get) => ({
  ...initialState,

  fetchBranches: async (projectId: string, projectDefaultBranch?: string | null) => {
    set({ loading: true, projectId });
    const result = await api.listBranches(projectId);
    if (result.isOk()) {
      const data = result.value;
      let selected = '';
      if (data.currentBranch && data.branches.includes(data.currentBranch)) {
        selected = data.currentBranch;
      } else if (projectDefaultBranch && data.branches.includes(projectDefaultBranch)) {
        selected = projectDefaultBranch;
      } else if (data.defaultBranch) {
        selected = data.defaultBranch;
      } else if (data.branches.length > 0) {
        selected = data.branches[0];
      }
      set({
        branches: data.branches,
        remoteBranches: data.remoteBranches ?? [],
        defaultBranch: data.defaultBranch,
        currentBranch: data.currentBranch,
        selectedBranch: selected,
        loading: false,
      });
    } else {
      set({ loading: false });
    }
  },

  setSelectedBranch: (branch: string) => set({ selectedBranch: branch }),

  setCurrentBranch: (branch: string) => set({ currentBranch: branch }),

  invalidate: () => set({ projectId: null }),

  reset: () => set(initialState),
}));
