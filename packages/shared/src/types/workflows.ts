import type { JsonObject } from '../json.js';

export type WorkflowSource = 'built-in' | 'user';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'waiting_approval'
  /** Waiting for a slot of its concurrency group (another run holds it). */
  | 'waiting_slot';

export interface WorkflowDiagnostic {
  path: string;
  message: string;
  /**
   * An `error` makes the workflow invalid (it cannot be saved or run); a
   * `warning` is shown but blocks nothing. Missing means `error`.
   */
  severity?: 'error' | 'warning';
}

/** Whether a diagnostic makes the workflow invalid (missing severity is an error). */
export function isErrorDiagnostic(diagnostic: WorkflowDiagnostic): boolean {
  return diagnostic.severity !== 'warning';
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
  inputs?: JsonObject;
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
  metadata?: JsonObject;
}
