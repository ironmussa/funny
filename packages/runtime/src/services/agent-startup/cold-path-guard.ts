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
 * ACP-backed providers can stream prior conversation history back as
 * fire-and-forget notifications that race with the loadSession response,
 * duplicating every assistant message and tool call in the DB on resume.
 * Rebuilding the prompt from DB-side context avoids that replay race.
 *
 * Claude and Pi SDK integrations resume without the ACP replay race, so we
 * exempt them.
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
  if (provider === 'pi') return false;
  return true;
}
