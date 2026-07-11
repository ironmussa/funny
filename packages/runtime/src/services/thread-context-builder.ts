/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 * @domain depends: ThreadManager
 *
 * Constructs conversation history for session recovery.
 */

import * as tm from './thread-manager.js';

/**
 * Build a formatted conversation history from a thread's messages.
 * Returns a string that can be prepended to the user's new message
 * to provide full context when the session cannot be resumed.
 */
/** Maximum number of recent messages to include in context recovery. */
const MAX_CONTEXT_MESSAGES = 40;

/** Maximum total character length for the recovered context string. */
const MAX_CONTEXT_LENGTH = 200_000;

export async function buildThreadContext(threadId: string): Promise<string | null> {
  const threadData = await tm.getThreadWithMessages(threadId);
  if (!threadData || !threadData.messages.length) {
    return null;
  }

  // Only keep the most recent messages to avoid OOM in the agent subprocess
  const allMessages = threadData.messages;
  const truncated = allMessages.length > MAX_CONTEXT_MESSAGES;
  const messages = truncated ? allMessages.slice(-MAX_CONTEXT_MESSAGES) : allMessages;

  const parts: string[] = [];

  // Add system note explaining this is a recovered context
  parts.push(
    '[SYSTEM NOTE: Your previous session cannot be resumed. Below is the conversation history to restore context. Continue naturally from where the conversation left off.]',
  );
  if (truncated) {
    parts.push(
      `[NOTE: Showing last ${MAX_CONTEXT_MESSAGES} of ${allMessages.length} messages. Earlier messages were omitted to save memory.]`,
    );
  }
  parts.push('');
  parts.push('=== CONVERSATION HISTORY ===');
  parts.push('');

  // Format each message in the conversation
  for (const msg of messages) {
    if (msg.role === 'user') {
      parts.push('USER:');
      parts.push(msg.content);
      if (msg.images && msg.images.length > 0) {
        parts.push(`[User provided ${msg.images.length} image(s)]`);
      }
    } else if (msg.role === 'assistant') {
      parts.push('');
      parts.push('ASSISTANT:');
      parts.push(msg.content);

      // Include tool calls if any
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        parts.push('');
        parts.push('Tool calls made:');
        for (const tc of msg.toolCalls) {
          parts.push(`- ${tc.name}`);
          if (tc.input) {
            try {
              const input = JSON.parse(tc.input);
              // Show abbreviated input for readability
              const inputStr = JSON.stringify(input, null, 2);
              if (inputStr.length > 200) {
                parts.push(`  Input: ${inputStr.slice(0, 200)}...`);
              } else {
                parts.push(`  Input: ${inputStr}`);
              }
            } catch {
              // Input might not be JSON
              const truncated = tc.input.length > 200 ? tc.input.slice(0, 200) + '...' : tc.input;
              parts.push(`  Input: ${truncated}`);
            }
          }
          if (tc.output) {
            const truncated = tc.output.length > 200 ? tc.output.slice(0, 200) + '...' : tc.output;
            parts.push(`  Output: ${truncated}`);
          }
        }
      }
    }
    parts.push('');
  }

  parts.push('=== END CONVERSATION HISTORY ===');
  parts.push('');

  let result = parts.join('\n');

  // Hard cap on total context length to prevent OOM in agent subprocesses
  if (result.length > MAX_CONTEXT_LENGTH) {
    result = result.slice(-MAX_CONTEXT_LENGTH);
    result = '[...context truncated for length...]\n' + result;
  }

  return result;
}

/**
 * Check if a thread needs context recovery.
 * Triggered by:
 * - Post-merge: worktree was merged+cleaned (mergedAt is set, sessionId exists)
 * - Model/provider change or DB-only fork: sessionId was cleared (or absent)
 *   and contextRecoveryReason was set
 */
export async function needsContextRecovery(threadId: string): Promise<boolean> {
  const thread = await tm.getThread(threadId);
  if (!thread) return false;
  // Post-merge: sessionId still exists + mergedAt flag
  if (thread.sessionId && thread.mergedAt) return true;
  // Model/provider changed or DB-only fork: recovery flag was set
  if (thread.contextRecoveryReason) return true;
  return false;
}
