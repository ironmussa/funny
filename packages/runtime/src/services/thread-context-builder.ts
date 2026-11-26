/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 * @domain depends: ThreadManager
 *
 * Constructs conversation history for session recovery.
 */

import { AUTO_RESUME_MESSAGE_AUTHOR, type Message, type ToolCall } from '@funny/shared';
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

/**
 * How far back to look for the user's request when the recent window holds
 * none: pages of older messages, read newest first.
 */
const TASK_LOOKUP_PAGE_SIZE = 100;
const TASK_LOOKUP_MAX_PAGES = 10;

type ContextMessage = Pick<Message, 'role' | 'content' | 'images'> & {
  author?: string | null;
  timestamp?: string;
  toolCalls?: ToolCall[];
};

/**
 * A message the user wrote, as opposed to the `continue` the runner sends to
 * resume a thread its restart interrupted.
 */
function isUserRequest(msg: ContextMessage): boolean {
  return msg.role === 'user' && msg.author !== AUTO_RESUME_MESSAGE_AUTHOR;
}

/**
 * The user's latest request before `before`, read from older history. An agent
 * that records one message per tool call (ACP providers) fills the recent
 * window within one turn, and runner restarts add only `continue` prompts, so
 * without this the recovered agent no longer knows what it was asked to do.
 */
async function findEarlierUserRequest(
  threadId: string,
  before: string,
): Promise<ContextMessage | null> {
  let cursor = before;
  for (let page = 0; page < TASK_LOOKUP_MAX_PAGES; page++) {
    const older = await tm.getThreadMessages({
      threadId,
      cursor,
      limit: TASK_LOOKUP_PAGE_SIZE,
      direction: 'before',
    });
    const messages: ContextMessage[] = older.messages;
    const request = [...messages].reverse().find(isUserRequest);
    if (request) return request;
    const oldest = messages[0]?.timestamp;
    if (!older.hasMore || !oldest) return null;
    cursor = oldest;
  }
  return null;
}

export async function buildThreadContext(threadId: string): Promise<string | null> {
  // Only the most recent messages are used (avoids OOM in the agent
  // subprocess), so only those are fetched: loading the whole history over the
  // runner tunnel just to drop most of it was the old cost.
  const threadData = await tm.getThreadWithMessages(threadId, MAX_CONTEXT_MESSAGES);
  if (!threadData || !threadData.messages.length) {
    return null;
  }

  const loaded = threadData.messages;
  const messages =
    loaded.length > MAX_CONTEXT_MESSAGES ? loaded.slice(-MAX_CONTEXT_MESSAGES) : loaded;
  const total: number = Math.max(threadData.total ?? loaded.length, loaded.length);
  const truncated = total > messages.length;

  const parts: string[] = [];

  // Add system note explaining this is a recovered context
  parts.push(
    '[SYSTEM NOTE: Your previous session cannot be resumed. Below is the conversation history to restore context. Continue naturally from where the conversation left off.]',
  );
  if (truncated) {
    parts.push(
      `[NOTE: Showing last ${messages.length} of ${total} messages. Earlier messages were omitted to save memory.]`,
    );
  }
  const oldestLoaded = messages[0]?.timestamp;
  const currentTask =
    truncated && oldestLoaded && !messages.some(isUserRequest)
      ? await findEarlierUserRequest(threadId, oldestLoaded)
      : null;
  if (currentTask) {
    parts.push('');
    parts.push("=== CURRENT TASK (the user's last request, older than the history below) ===");
    parts.push('');
    appendMessage(parts, currentTask);
    parts.push('');
    parts.push('=== END CURRENT TASK ===');
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

function appendMessage(parts: string[], msg: ContextMessage): void {
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
