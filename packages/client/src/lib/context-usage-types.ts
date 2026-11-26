import type { AgentProvider, ContextBreakdown } from '@funny/shared';

export interface ContextUsage {
  cumulativeInputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  /** Provider whose run reported this usage; scopes `maxTokens` and `breakdown`. */
  provider?: AgentProvider;
  /** Model selected for the run that reported this usage. */
  model?: string;
  /** Context window the provider reported for the run (e.g. ACP `usage_update.size`). */
  maxTokens?: number;
  /** Latest end-of-turn per-category snapshot (Claude SDK only). */
  breakdown?: ContextBreakdown;
}
