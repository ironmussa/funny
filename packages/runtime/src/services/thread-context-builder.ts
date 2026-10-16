/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 * @domain depends: ThreadManager
 *
 * Constructs conversation history for session recovery.
 */

import type { Message, ToolCall } from '@funny/shared';
import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

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

  for (const msg of messages) {
    appendMessage(parts, msg);
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

function abbreviateToolValue(value: string): string {
  return value.length > 200 ? value.slice(0, 200) + '...' : value;
}

function formatToolInput(input: string): string {
  const parsed = parseStoredJson(z.unknown(), input, 'tool input');
  return abbreviateToolValue(parsed.ok ? JSON.stringify(parsed.value, null, 2) : input);
}

function appendToolCalls(parts: string[], toolCalls: ToolCall[]): void {
  parts.push('', 'Tool calls made:');
  for (const tc of toolCalls) {
    parts.push(`- ${tc.name}`);
    if (tc.input) parts.push(`  Input: ${formatToolInput(tc.input)}`);
    if (tc.output) parts.push(`  Output: ${abbreviateToolValue(tc.output)}`);
  }
}

function appendMessage(
  parts: string[],
  msg: Pick<Message, 'role' | 'content' | 'images'> & { toolCalls?: ToolCall[] },
): void {
  if (msg.role === 'user') {
    parts.push('USER:', msg.content);
    if (msg.images?.length) {
      parts.push(`[User provided ${msg.images.length} image(s)]`);
    }
  } else if (msg.role === 'assistant') {
    parts.push('', 'ASSISTANT:', msg.content);
    if (msg.toolCalls?.length) appendToolCalls(parts, msg.toolCalls);
  }
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
