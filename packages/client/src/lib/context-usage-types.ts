import type { ContextBreakdown } from '@funny/shared';

export interface ContextUsage {
  cumulativeInputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  /** Latest end-of-turn per-category snapshot (Claude SDK only). */
  breakdown?: ContextBreakdown;
}
