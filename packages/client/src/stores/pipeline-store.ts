import type { PipelineRun } from '@funny/shared';
import { create } from 'zustand';

export interface PipelineState {
  /** Active pipeline runs keyed by source threadId */
  activeRuns: Record<string, PipelineRun>;

  /** Handle pipeline:started WS event */
  handlePipelineStarted: (data: PipelineRun) => void;

  /** Handle pipeline:stage_completed WS event */
  handlePipelineStageCompleted: (data: PipelineRun) => void;

  /** Handle pipeline:completed WS event */
  handlePipelineCompleted: (data: PipelineRun) => void;

  /** Handle pipeline:failed WS event */
  handlePipelineFailed: (data: PipelineRun) => void;

  /** Clear a run from active state */
  clearRun: (threadId: string) => void;
}

export const usePipelineStore = create<PipelineState>((set) => ({
  activeRuns: {},

  handlePipelineStarted: (data) =>
    set((state) => ({
      activeRuns: { ...state.activeRuns, [data.threadId]: data },
    })),

  handlePipelineStageCompleted: (data) =>
    set((state) => ({
      activeRuns: { ...state.activeRuns, [data.threadId]: data },
    })),

  handlePipelineCompleted: (data) =>
    set((state) => ({
      activeRuns: { ...state.activeRuns, [data.threadId]: data },
    })),

  handlePipelineFailed: (data) =>
    set((state) => ({
      activeRuns: { ...state.activeRuns, [data.threadId]: data },
    })),

  clearRun: (threadId) =>
    set((state) => {
      const { [threadId]: _, ...rest } = state.activeRuns;
      return { activeRuns: rest };
    }),
}));
