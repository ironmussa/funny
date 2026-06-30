export type WorkflowSource = 'built-in' | 'user';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'waiting_approval';

export interface WorkflowDiagnostic {
  path: string;
  message: string;
}

export interface WorkflowSummary {
  name: string;
  description?: string;
  source: WorkflowSource;
  filePath?: string;
  hasOverride: boolean;
}

export interface WorkflowGraphDto {
  nodes: unknown[];
  edges: unknown[];
}

export interface WorkflowDefinitionResponse {
  summary: WorkflowSummary;
  yaml: string;
  parsed: unknown;
  graph: WorkflowGraphDto;
  diagnostics: WorkflowDiagnostic[];
}

export interface WorkflowListResponse {
  workflows: WorkflowSummary[];
  warnings: string[];
}

export interface WorkflowValidateRequest {
  yaml: string;
}

export interface WorkflowValidateResponse {
  ok: boolean;
  parsed?: unknown;
  graph?: WorkflowGraphDto;
  diagnostics: WorkflowDiagnostic[];
}

export interface WorkflowSaveRequest {
  projectId: string;
  yaml: string;
}

export interface WorkflowSaveResponse {
  ok: true;
  workflow: WorkflowDefinitionResponse;
}

export interface WorkflowRunRequest {
  threadId: string;
  workflowName?: string;
  prompt?: string;
  inputs?: Record<string, unknown>;
}

export interface WorkflowRunResponse {
  runId: string;
  pipelineRunId: string;
}

export interface WorkflowCancelResponse {
  ok: true;
  found: boolean;
}

export interface WorkflowNodeRunState {
  runId: string;
  workflowName: string;
  nodeId: string;
  status: WorkflowNodeRunStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}
