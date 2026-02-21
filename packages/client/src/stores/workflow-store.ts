import { create } from 'zustand';
import { api } from '@/lib/api';
import type { WSWorkflowStepData, WSWorkflowStatusData } from '@funny/shared';

export interface WorkflowStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  completedAt?: string;
  output?: Record<string, unknown>;
}

export interface WorkflowRun {
  runId: string;
  workflowName: string;
  projectId: string;
  status: 'triggered' | 'running' | 'completed' | 'failed';
  steps: WorkflowStep[];
  startedAt: string;
  completedAt?: string;
  qualityScores?: Record<string, { status: string; details: string }>;
}

interface WorkflowState {
  runs: WorkflowRun[];
  selectedRunId: string | null;

  triggerWorkflow: (name: string, input: Record<string, unknown>, projectId: string) => Promise<string | null>;
  selectRun: (runId: string | null) => void;
  handleWorkflowStatus: (data: WSWorkflowStatusData) => void;
  handleWorkflowStep: (data: WSWorkflowStepData) => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runs: [],
  selectedRunId: null,

  triggerWorkflow: async (name, input, projectId) => {
    const result = await api.triggerWorkflow(name, input);
    if (result.isErr()) {
      console.error('[workflow-store] Failed to trigger workflow:', result.error.message);
      return null;
    }
    const { run_id } = result.value;
    const newRun: WorkflowRun = {
      runId: run_id,
      workflowName: name,
      projectId,
      status: 'triggered',
      steps: [],
      startedAt: new Date().toISOString(),
    };
    set((state) => ({
      runs: [newRun, ...state.runs],
      selectedRunId: run_id,
    }));
    return run_id;
  },

  selectRun: (runId) => set({ selectedRunId: runId }),

  handleWorkflowStatus: (data) => {
    set((state) => {
      const existing = state.runs.find((r) => r.runId === data.runId);
      if (existing) {
        return {
          runs: state.runs.map((r) =>
            r.runId === data.runId
              ? {
                  ...r,
                  status: data.status,
                  ...(data.qualityScores ? { qualityScores: data.qualityScores } : {}),
                  ...(data.status === 'completed' || data.status === 'failed'
                    ? { completedAt: new Date().toISOString() }
                    : {}),
                }
              : r
          ),
        };
      }
      // Run not tracked locally (e.g. triggered from another tab)
      const newRun: WorkflowRun = {
        runId: data.runId,
        workflowName: data.workflowName,
        projectId: '',
        status: data.status,
        steps: [],
        startedAt: new Date().toISOString(),
        ...(data.qualityScores ? { qualityScores: data.qualityScores } : {}),
      };
      return { runs: [newRun, ...state.runs] };
    });
  },

  handleWorkflowStep: (data) => {
    set((state) => ({
      runs: state.runs.map((r) => {
        if (r.runId !== data.runId) return r;
        const existingIdx = r.steps.findIndex((s) => s.name === data.stepName);
        const step: WorkflowStep = {
          name: data.stepName,
          status: data.status,
          ...(data.status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
          ...(data.output ? { output: data.output } : {}),
        };
        const steps = [...r.steps];
        if (existingIdx >= 0) {
          steps[existingIdx] = step;
        } else {
          steps.push(step);
        }
        return { ...r, steps };
      }),
    }));
  },
}));
