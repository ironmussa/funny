/**
 * Agent pipeline types — roles, context, and results.
 *
 * These types define the structured data passed between agents in a pipeline.
 * Hatchet (or any orchestrator) passes AgentContext between steps;
 * each agent produces an AgentResult that accumulates in previousResults.
 */

// ── Agent Role Definition ─────────────────────────────────────

export interface AgentRole {
  /** Unique name for this agent role (e.g., 'tests', 'security') */
  name: string;
  /** System prompt that defines the agent's behavior */
  systemPrompt: string;
  /** Full model identifier (e.g., 'claude-sonnet-4-5-20250929', 'gpt-4-turbo') */
  model: string;
  /** LLM provider name (e.g., 'anthropic', 'openai', 'ollama') */
  provider: string;
  /** Names of additional tools beyond the built-in set */
  tools: string[];
  /** Maximum agentic loop iterations before forced stop */
  maxTurns: number;
  /** Temperature for the LLM (default: provider's default) */
  temperature?: number;
  /** Max tokens per response */
  maxTokens?: number;
  /** Glob patterns for project docs to inject into context (Progressive Disclosure) */
  contextDocs?: string[];
}

// ── Diff Statistics ───────────────────────────────────────────

export interface DiffStats {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  changed_files: string[];
}

// ── Agent Context (accumulated across pipeline stages) ────────

export interface AgentContext {
  /** Git branch being reviewed */
  branch: string;
  /** Working directory (worktree path) */
  worktreePath: string;
  /** Changeset tier classification */
  tier: 'small' | 'medium' | 'large';
  /** Diff statistics */
  diffStats: DiffStats;
  /** Results from previous agents in the pipeline (accumulated) */
  previousResults: AgentResult[];
  /** Base branch for diff comparison */
  baseBranch: string;
  /** Additional metadata passed through the pipeline */
  metadata?: Record<string, unknown>;
}

// ── Agent Result ──────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  severity: FindingSeverity;
  description: string;
  file?: string;
  line?: number;
  fix_applied: boolean;
  fix_description?: string;
}

export type AgentResultStatus = 'passed' | 'failed' | 'error' | 'timeout';

export interface AgentResult {
  /** Which agent produced this result */
  agent: string;
  /** Overall status */
  status: AgentResultStatus;
  /** Individual findings */
  findings: Finding[];
  /** Total fixes applied */
  fixes_applied: number;
  /** Execution metadata */
  metadata: {
    duration_ms: number;
    turns_used: number;
    tokens_used: { input: number; output: number };
    model: string;
    provider: string;
  };
}
