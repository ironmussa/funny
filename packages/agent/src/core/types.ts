/**
 * Domain types for the Agent Service.
 */

// ── Events ──────────────────────────────────────────────────────

export type PipelineEventType =
  // Session lifecycle events
  | 'session.created'
  | 'session.transition'
  | 'session.accepted'
  | 'session.plan_ready'
  | 'session.implementing'
  | 'session.pr_created'
  | 'session.ci_passed'
  | 'session.ci_failed'
  | 'session.review_requested'
  | 'session.changes_requested'
  | 'session.merged'
  | 'session.failed'
  | 'session.escalated'
  // Reaction events
  | 'reaction.triggered'
  | 'reaction.agent_respawned'
  | 'reaction.escalated'
  | 'reaction.auto_merged'
  // Backlog events
  | 'backlog.scan_started'
  | 'backlog.scan_completed'
  | 'backlog.issue_picked';

export interface PipelineEvent {
  event_type: PipelineEventType;
  request_id: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
