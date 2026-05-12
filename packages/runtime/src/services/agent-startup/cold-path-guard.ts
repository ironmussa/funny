import type { AgentProvider } from '@funny/shared';

interface ColdPathInput {
  thread:
    | {
        sessionId?: string | null;
        contextRecoveryReason?: string | null;
        mergedAt?: string | null;
      }
    | null
    | undefined;
  isRunning: boolean;
  provider: AgentProvider;
}

/**
 * Decide whether to force cold-path context recovery before resuming an agent.
 *
 * gemini-cli / codex / pi-coding-agent stream prior conversation history back
 * as fire-and-forget notifications that race with the loadSession response,
 * duplicating every assistant message and tool call in the DB on resume.
 * Rebuilding the prompt from DB-side context avoids that replay race.
 *
 * The Claude SDK resumes by sessionId without that race, so we exempt it —
 * forcing recovery there would invalidate the prompt cache on every follow-up
 * and regenerate ~25k tokens of cache_creation per turn.
 */
export function shouldForceColdPathRecovery({
  thread,
  isRunning,
  provider,
}: ColdPathInput): boolean {
  if (!thread?.sessionId) return false;
  if (isRunning) return false;
  if (thread.contextRecoveryReason) return false;
  if (thread.mergedAt) return false;
  if (provider === 'claude') return false;
  return true;
}
