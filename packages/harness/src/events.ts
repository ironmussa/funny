import type { HarnessError } from './errors.js';

export type HarnessEvent =
  | HarnessSessionStartedEvent
  | HarnessSessionMessageEvent
  | HarnessSessionToolCallEvent
  | HarnessSessionCompletedEvent
  | HarnessSessionErrorEvent
  | HarnessWorkflowProgressEvent
  | HarnessWorkflowCompletedEvent
  | HarnessWorkflowFailedEvent
  | HarnessWorkflowCancelledEvent
  | HarnessSandboxResolvedEvent
  | HarnessRawEvent;

export interface HarnessEventBase {
  type: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessSessionStartedEvent extends HarnessEventBase {
  type: 'session.started';
  sessionId?: string;
  prompt: string;
}

export interface HarnessSessionMessageEvent extends HarnessEventBase {
  type: 'session.message';
  role: 'system' | 'assistant' | 'user';
  text?: string;
  raw?: unknown;
}

export interface HarnessSessionToolCallEvent extends HarnessEventBase {
  type: 'session.tool_call';
  id?: string;
  name: string;
  input: unknown;
  raw?: unknown;
}

export interface HarnessSessionCompletedEvent extends HarnessEventBase {
  type: 'session.completed';
  sessionId?: string;
  output?: string;
  raw?: unknown;
}

export interface HarnessSessionErrorEvent extends HarnessEventBase {
  type: 'session.error';
  error: HarnessError;
}

export interface HarnessWorkflowProgressEvent extends HarnessEventBase {
  type: 'workflow.progress';
  workflowName: string;
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface HarnessWorkflowCompletedEvent extends HarnessEventBase {
  type: 'workflow.completed';
  workflowName: string;
}

export interface HarnessWorkflowFailedEvent extends HarnessEventBase {
  type: 'workflow.failed';
  workflowName: string;
  error: string;
}

export interface HarnessWorkflowCancelledEvent extends HarnessEventBase {
  type: 'workflow.cancelled';
  workflowName: string;
}

export interface HarnessSandboxResolvedEvent extends HarnessEventBase {
  type: 'sandbox.resolved';
  sandboxId?: string;
  backend: 'local' | 'process' | 'runner';
}

export interface HarnessRawEvent extends HarnessEventBase {
  type: 'session.raw';
  raw: unknown;
}

export type HarnessEventSink = (event: HarnessEvent) => void | Promise<void>;

export function nowIso(): string {
  return new Date().toISOString();
}
