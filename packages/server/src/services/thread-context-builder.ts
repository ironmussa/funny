/**
 * Thread context builder — constructs conversation history for session recovery.
 *
 * When a session cannot be resumed (e.g., worktree merged and deleted),
 * this module builds a formatted conversation history to pass as context
 * to a fresh Claude session.
 */

import * as tm from './thread-manager.js';

/**
 * Build a formatted conversation history from a thread's messages.
 * Returns a string that can be prepended to the user's new message
 * to provide full context when the session cannot be resumed.
 */
export function buildThreadContext(threadId: string): string | null {
  const threadData = tm.getThreadWithMessages(threadId);
  if (!threadData || !threadData.messages.length) {
    return null;
  }

  const parts: string[] = [];

  // Add system note explaining this is a recovered context
  parts.push('[SYSTEM NOTE: Your previous session cannot be resumed (the working directory was removed after a merge). Below is the complete conversation history to restore context. Continue naturally from where the conversation left off.]');
  parts.push('');
  parts.push('=== CONVERSATION HISTORY ===');
  parts.push('');

  // Format each message in the conversation
  for (const msg of threadData.messages) {
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

  return parts.join('\n');
}

/**
 * Check if a thread needs context recovery (has sessionId but no valid resume path).
 * This happens when a worktree was merged and cleaned up.
 */
export function needsContextRecovery(threadId: string): boolean {
  const thread = tm.getThread(threadId);
  if (!thread || !thread.sessionId) {
    return false;
  }

  // If thread has a sessionId but the worktree was removed (post-merge scenario)
  const isPostMerge = !!(thread.sessionId && thread.baseBranch && !thread.worktreePath);

  return isPostMerge;
}
