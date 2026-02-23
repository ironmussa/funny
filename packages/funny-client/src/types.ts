/**
 * Types for the funny-client package.
 *
 * These mirror the IngestEvent contract accepted by the funny server
 * at POST /api/ingest/webhook.
 */

// ── Event types ─────────────────────────────────────────────────

export type PipelineEventType =
  | 'pipeline.accepted'
  | 'pipeline.started'
  | 'pipeline.containers.ready'
  | 'pipeline.tier_classified'
  | 'pipeline.agent.started'
  | 'pipeline.agent.completed'
  | 'pipeline.agent.failed'
  | 'pipeline.correcting'
  | 'pipeline.correction.started'
  | 'pipeline.correction.completed'
  | 'pipeline.completed'
  | 'pipeline.failed'
  | 'pipeline.stopped'
  | 'pipeline.message'
  | 'pipeline.cli_message'
  | 'director.activated'
  | 'director.integration.dispatched'
  | 'director.integration.pr_created'
  | 'director.pr.rebase_needed'
  | 'director.cycle.completed'
  | 'integration.started'
  | 'integration.conflict.detected'
  | 'integration.conflict.resolved'
  | 'integration.pr.created'
  | 'integration.completed'
  | 'integration.failed'
  | 'integration.pr.merged'
  | 'integration.pr.rebased'
  | 'integration.pr.rebase_failed'
  | 'cleanup.started'
  | 'cleanup.completed'
  | 'workflow.started'
  | 'workflow.step.completed'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'review_loop.started'
  | 'review_loop.feedback_applied'
  | 'review_loop.push_completed'
  | 'review_loop.completed'
  | 'review_loop.failed';

// ── Ingest event (webhook payload) ──────────────────────────────

export interface IngestEvent {
  event_type: PipelineEventType | (string & {});
  request_id: string;
  thread_id?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ── Client configuration ────────────────────────────────────────

export interface FunnyClientConfig {
  /** Base URL of the funny server (e.g. "http://localhost:3001") */
  baseUrl: string;
  /** Webhook secret for authentication (INGEST_WEBHOOK_SECRET) */
  secret: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

// ── Response types ──────────────────────────────────────────────

export interface WebhookResponse {
  status: 'ok';
  thread_id?: string;
  skipped?: boolean;
}

export interface WebhookErrorResponse {
  error: string;
}

// ── CLI message helpers ─────────────────────────────────────────

export type CLIMessageRole = 'system' | 'assistant' | 'user' | 'result';

export interface CLIMessage {
  role: CLIMessageRole;
  content: string;
  /** Optional message ID for streaming updates to the same message */
  id?: string;
  /** Tool use block for assistant tool calls */
  tool_use?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  /** Tool result block */
  tool_result?: {
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  };
}
