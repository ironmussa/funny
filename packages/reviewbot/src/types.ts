/**
 * Internal types for the ReviewBot package.
 */

export interface ReviewOptions {
  /** LLM model identifier (default: claude-sonnet-4-5-20250929) */
  model?: string;
  /** LLM provider (default: anthropic) */
  provider?: string;
  /** Max agent turns (default: 50) */
  maxTurns?: number;
  /** Whether to post the review to GitHub (default: true) */
  post?: boolean;
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
