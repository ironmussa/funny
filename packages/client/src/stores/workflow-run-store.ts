import type { WorkflowNodeRunState } from '@funny/shared/types/workflows';
import { create } from 'zustand';

interface WorkflowRunStoreState {
  runs: Record<string, Record<string, WorkflowNodeRunState>>;
  activeRunId: string | null;
  handleNodeState: (state: WorkflowNodeRunState) => void;
  setActiveRun: (runId: string | null) => void;
  clearRun: (runId: string) => void;
}

export const useWorkflowRunStore = create<WorkflowRunStoreState>((set) => ({
  runs: {},
  activeRunId: null,
  handleNodeState: (nodeState) =>
    set((state) => ({
      activeRunId: state.activeRunId ?? nodeState.runId,
      runs: {
        ...state.runs,
        [nodeState.runId]: {
          ...(state.runs[nodeState.runId] ?? {}),
          [nodeState.nodeId]: nodeState,
        },
      },
    })),
  setActiveRun: (runId) => set({ activeRunId: runId }),
  clearRun: (runId) =>
    set((state) => {
      const { [runId]: _, ...runs } = state.runs;
      return {
        runs,
        activeRunId: state.activeRunId === runId ? null : state.activeRunId,
      };
    }),
}));
