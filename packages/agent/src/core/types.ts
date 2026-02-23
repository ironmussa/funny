/**
 * Domain types for the Pipeline Service.
 */

// ── Enums / Unions ──────────────────────────────────────────────

export type Tier = 'small' | 'medium' | 'large';

export type PipelineStatus =
  | 'accepted'
  | 'running'
  | 'correcting'
  | 'approved'
  | 'failed'
  | 'error';

export type AgentName =
  | 'tests'
  | 'security'
  | 'architecture'
  | 'performance'
  | 'style'
  | 'types'
  | 'docs'
  | 'integration'
  | 'e2e';

// ── Request / Response ──────────────────────────────────────────

export interface PipelineConfig {
  /** Override tier classification */
  tier?: Tier;
  /** Override which agents to run */
  agents?: AgentName[];
  /** Model to use for the pipeline agent */
  model?: string;
  /** Max turns for the agent */
  maxTurns?: number;
  /** URL of the running app for E2E browser testing */
  appUrl?: string;
  /** Skip the integration/merge step after pipeline completes */
  skip_merge?: boolean;
}

export interface PipelineRequest {
  request_id: string;
  branch: string;
  worktree_path: string;
  base_branch?: string;
  config?: PipelineConfig;
  metadata?: Record<string, unknown>;
}

// ── Events ──────────────────────────────────────────────────────

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
  // Director events
  | 'director.activated'
  | 'director.integration.dispatched'
  | 'director.integration.pr_created'
  | 'director.pr.rebase_needed'
  | 'director.cycle.completed'
  // Integration events
  | 'integration.started'
  | 'integration.conflict.detected'
  | 'integration.conflict.resolved'
  | 'integration.pr.created'
  | 'integration.completed'
  | 'integration.failed'
  | 'integration.pr.merged'
  // Rebase events
  | 'integration.pr.rebased'
  | 'integration.pr.rebase_failed'
  // Cleanup events
  | 'cleanup.started'
  | 'cleanup.completed'
  // Hatchet workflow events
  | 'workflow.started'
  | 'workflow.step.completed'
  | 'workflow.completed'
  | 'workflow.failed'
  // Review loop events
  | 'review_loop.started'
  | 'review_loop.feedback_applied'
  | 'review_loop.push_completed'
  | 'review_loop.completed'
  | 'review_loop.failed';

export interface PipelineEvent {
  event_type: PipelineEventType;
  request_id: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Re-export branch lifecycle state from state-machine
export type { BranchState } from './state-machine.js';

// ── State ───────────────────────────────────────────────────────

export interface PipelineState {
  request_id: string;
  status: PipelineStatus;
  tier: Tier | null;
  pipeline_branch: string;
  started_at: string;
  completed_at?: string;
  request: PipelineRequest;
  events_count: number;
  corrections_count: number;
  corrections_applied: string[];
}
