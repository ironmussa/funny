/**
 * Types for the manifest system — `.pipeline/manifest.json`.
 *
 * The manifest tracks the lifecycle of branches through three states:
 *   ready[] → pending_merge[] → merge_history[]
 */

import type { Tier } from './types.js';

// ── Agent result within a pipeline run ──────────────────────────

export interface AgentResult {
  status: 'pass' | 'fail' | 'skip' | 'error';
  details: string;
}

// ── Manifest entries ────────────────────────────────────────────

/** Branch approved by pipeline, ready for integration */
export interface ManifestReadyEntry {
  branch: string;
  pipeline_branch: string;
  worktree_path: string;
  request_id: string;
  tier: Tier;
  pipeline_result: Record<string, AgentResult>;
  corrections_applied: string[];
  ready_at: string;
  priority: number;
  depends_on: string[];
  base_main_sha: string;
  base_branch?: string;
  metadata?: Record<string, unknown>;
}

/** PR created, waiting for merge */
export interface ManifestPendingMergeEntry {
  branch: string;
  pipeline_branch: string;
  integration_branch: string;
  worktree_path: string;
  request_id: string;
  tier: Tier;
  pr_number: number;
  pr_url: string;
  pr_created_at: string;
  base_main_sha: string;
  pipeline_result: Record<string, AgentResult>;
  corrections_applied: string[];
  priority: number;
  depends_on: string[];
  metadata?: Record<string, unknown>;
}

/** Already merged into main */
export interface ManifestMergeHistoryEntry {
  branch: string;
  pr_number: number;
  commit_sha: string;
  merged_at: string;
  metadata?: Record<string, unknown>;
}

// ── Manifest (top-level) ────────────────────────────────────────

export interface Manifest {
  main_branch: string;
  main_head: string;
  last_updated: string;
  ready: ManifestReadyEntry[];
  pending_merge: ManifestPendingMergeEntry[];
  merge_history: ManifestMergeHistoryEntry[];
}

// ── Integrator result ───────────────────────────────────────────

export interface IntegratorResult {
  success: boolean;
  pr_number?: number;
  pr_url?: string;
  integration_branch?: string;
  base_main_sha?: string;
  conflicts_resolved?: boolean;
  error?: string;
}

// ── Director status ─────────────────────────────────────────────

export interface DirectorStatus {
  running: boolean;
  last_cycle_at: string | null;
  manifest_summary: {
    ready: number;
    pending_merge: number;
    merge_history: number;
  };
  merge_queue: Array<{
    branch: string;
    priority: number;
    eligible: boolean;
    blocked_by?: string[];
  }>;
}
