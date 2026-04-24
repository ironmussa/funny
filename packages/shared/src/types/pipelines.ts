import type { AgentModel, PermissionMode } from '../types.js';

// ─── Pipelines ──────────────────────────────────────────

export type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed';
export type PipelineRunStatus =
  | 'running'
  | 'reviewing'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'skipped';
export type PipelineStageType = 'reviewer' | 'corrector';
export type PipelineVerdict = 'pass' | 'fail';

export interface PipelineStageConfig {
  type: PipelineStageType;
  model: AgentModel;
  permissionMode: PermissionMode;
  prompt: string;
}

export interface Pipeline {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  enabled: boolean;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxIterations: number;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled: boolean;
  testCommand?: string;
  testFixEnabled: boolean;
  testFixModel: AgentModel;
  testFixMaxIterations: number;
  testFixerPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  threadId: string;
  status: PipelineRunStatus;
  currentStage: PipelineStageType;
  iteration: number;
  maxIterations: number;
  commitSha?: string;
  verdict?: PipelineVerdict;
  findings?: string;
  fixerThreadId?: string;
  precommitIteration?: number;
  hookName?: string;
  hookError?: string;
  createdAt: string;
  completedAt?: string;
}

// ─── Pipeline WebSocket Events ──────────────────────────

export interface WSPipelineRunStartedData {
  pipelineId: string;
  runId: string;
  threadId: string;
  commitSha?: string;
}

export interface WSPipelineStageUpdateData {
  pipelineId: string;
  runId: string;
  threadId: string;
  stage: PipelineStageType;
  iteration: number;
  maxIterations: number;
  verdict?: PipelineVerdict;
  findings?: string;
}

export interface WSPipelineRunCompletedData {
  pipelineId: string;
  runId: string;
  threadId: string;
  status: PipelineRunStatus;
  totalIterations: number;
}
