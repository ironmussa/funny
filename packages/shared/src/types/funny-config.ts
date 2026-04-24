// ─── Project Worktree Configuration (.funny.json) ───────

export interface FunnyPortGroup {
  name: string;
  basePort: number;
  envVars: string[];
}

/** A managed process definition from .funny.json or Procfile */
export interface FunnyProcessConfig {
  name: string;
  command: string;
  /** Auto-restart on non-zero exit (default: true for Procfile, false for .funny.json) */
  autoRestart?: boolean;
  /** Max restarts within restartWindowSec before giving up (default: 5) */
  maxRestarts?: number;
  /** Time window in seconds for restart counting (default: 60) */
  restartWindowSec?: number;
}

/** An automation definition from .funny.json */
export interface FunnyAutomationConfig {
  name: string;
  prompt: string;
  schedule: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
}

export interface FunnyProjectConfig {
  /** Relative paths to .env files to copy into worktrees (e.g. "packages/runtime/.env") */
  envFiles?: string[];
  /** Port groups — each group gets one unique port shared across its envVars */
  portGroups?: FunnyPortGroup[];
  /** Shell commands to run in the worktree after creation (e.g. ["bun install"]) */
  postCreate?: string[];
  /** Managed processes — auto-started with the project, optionally auto-restarted */
  processes?: FunnyProcessConfig[];
  /** Automations — synced to DB on project load */
  automations?: FunnyAutomationConfig[];
}

/** Source of an automation: created in UI or synced from .funny.json config */
export type AutomationSource = 'ui' | 'config';

/** Process health metrics emitted via WebSocket */
export interface WSCommandMetricsData {
  commandId: string;
  projectId: string;
  uptime: number;
  restartCount: number;
  memoryUsageKB: number;
}

// ─── Native Git Build (WebSocket events) ────────────────

export interface WSNativeGitBuildOutputData {
  text: string;
  channel: 'stdout' | 'stderr';
}

export interface WSNativeGitBuildStatusData {
  status: 'building' | 'completed' | 'failed';
  exitCode?: number;
}
