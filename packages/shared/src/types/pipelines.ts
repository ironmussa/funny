import type { AgentModel } from '../models.js';
import type { PermissionMode } from '../primitives.js';

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

// ─── Approval gates (human-in-the-loop) ─────────────────
//
// Mirrors Archon's approval-node semantics so workflows defined in either
// system share the same data model. See packages/runtime/src/pipelines/approval.ts.

export interface WSPipelineApprovalRequestedData {
  /** Globally-unique id for this pending approval. Used by the response endpoint. */
  approvalId: string;
  /** Stable id of the gate within the pipeline run (matches the node name). */
  gateId: string;
  /** User-facing message displayed in the approval UI. */
  message: string;
  /** If true, the UI should expose a free-text comment field. */
  captureResponse: boolean;
  /** Pipeline run that is paused on this approval. */
  runId?: string;
  /** Pipeline that defines the gate. */
  pipelineId?: string;
  /** Workflow id (when this approval is part of a higher-level workflow). */
  workflowId?: string;
  /** Thread id the pipeline is associated with. */
  threadId: string;
  /** ISO timestamp when the approval was requested. */
  requestedAt: string;
  /** Optional ISO timestamp when the approval will time out. */
  expiresAt?: string;
}

export interface WSPipelineApprovalResolvedData {
  approvalId: string;
  gateId: string;
  threadId: string;
  decision: 'approve' | 'reject' | 'timeout';
  /** On approve: optional comment. On reject: rejection reason. */
  payload?: string;
}
