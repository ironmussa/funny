import type { WaitingReason } from '@funny/shared';

/**
 * Tracks per-thread DB-mapping state for running agents.
 * Lifecycle fields (activeAgents, manuallyStopped) are now owned
 * by AgentOrchestrator in @funny/core.
 */
export class AgentStateTracker {
  /**
   * Threads that received a result message — used by AgentMessageHandler
   * to deduplicate result processing. Separate from the orchestrator's
   * lifecycle-level resultReceived which governs error/exit suppression.
   */
  readonly resultReceived = new Set<string>();

  /** Current assistant message DB ID per thread */
  readonly currentAssistantMsgId = new Map<string, string>();

  /**
   * CLI tool_use block IDs → our DB toolCallId per thread.
   * Preserved across session resume to deduplicate re-sent content.
   */
  readonly processedToolUseIds = new Map<string, Map<string, string>>();

  /**
   * CLI message IDs → our DB message IDs per thread.
   * Preserved across session resume.
   */
  readonly cliToDbMsgId = new Map<string, Map<string, string>>();

  /** Threads waiting for user input (AskUserQuestion / ExitPlanMode) */
  readonly pendingUserInput = new Map<string, WaitingReason>();

  /** Pending permission requests per thread */
  readonly pendingPermissionRequest = new Map<string, { toolName: string; toolUseId: string }>();

  /** Cumulative input token count per thread (tracks context window usage) */
  readonly cumulativeInputTokens = new Map<string, number>();

  /**
   * Clear stale state when starting a new agent run.
   * processedToolUseIds and cliToDbMsgId are intentionally preserved
   * across sessions to deduplicate re-sent content on --resume.
   */
  clearRunState(threadId: string): void {
    this.currentAssistantMsgId.delete(threadId);
    this.resultReceived.delete(threadId);
    this.pendingUserInput.delete(threadId);
    this.cumulativeInputTokens.delete(threadId);
  }

  /** Completely remove all in-memory state for a thread. */
  cleanupThread(threadId: string): void {
    this.resultReceived.delete(threadId);
    this.currentAssistantMsgId.delete(threadId);
    this.processedToolUseIds.delete(threadId);
    this.cliToDbMsgId.delete(threadId);
    this.pendingUserInput.delete(threadId);
    this.pendingPermissionRequest.delete(threadId);
    this.cumulativeInputTokens.delete(threadId);
  }
}
