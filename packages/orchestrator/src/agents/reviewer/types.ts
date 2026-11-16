/**
 * Internal types for the review module.
 */

import type { IAgentProcessFactory } from '@funny/core/agents';

export interface ReviewOptions {
  /** LLM model identifier (default: claude-sonnet-4-5-20250929) */
  model?: string;
  /** Agent provider — 'claude' | 'codex' | 'gemini' | 'llm-api' (default: claude) */
  provider?: string;
  /** Max agent turns (default: 1 — single-pass review) */
  maxTurns?: number;
  /** Whether to post the review to GitHub (default: true) */
  post?: boolean;
}

export interface PRReviewerConfig {
  /** Agent process factory for creating LLM processes. Uses defaultProcessFactory if not provided. */
  processFactory?: IAgentProcessFactory;
}

export interface ParsedFinding {
  severity: string;
  category: string;
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface ParsedReviewOutput {
  summary: string;
  findings: ParsedFinding[];
}
