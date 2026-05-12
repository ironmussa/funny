/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Helpers for talking to the Claude Agent SDK at a specific transcript
 * position. Both fork and rewind need to map a DB message id to the SDK's
 * transcript UUID, so that mapping lives here.
 */

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A SessionMessage from the SDK whose `message` payload is a real user
 * prompt (not a tool_result). Tool result entries are also `type: 'user'` in
 * the transcript, so we filter them out by inspecting content blocks.
 */
export function isPromptUserMessage(sm: SessionMessage): boolean {
  if (sm.type !== 'user') return false;
  const m = (sm as any).message;
  if (!m) return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return true;
  return !m.content.some((b: any) => b?.type === 'tool_result');
}

export interface ResolveSdkUuidParams {
  sessionId: string;
  cwd: string;
  /**
   * 0-based index of the target user message among role==='user' DB rows.
   * Callers compute this from the DB transcript prefix to keep this helper
   * decoupled from DB shapes.
   */
  userMsgIndex: number;
}

/**
 * Read the SDK transcript and resolve the UUID of the user prompt at
 * `userMsgIndex`. Throws via the supplied factory when the session can't be
 * read or the index is out of range.
 */
export async function resolveSdkUserMessageUuid(
  params: ResolveSdkUuidParams,
  onError: (code: 'transcript_read_failed' | 'sdk_message_not_found', detail?: string) => never,
): Promise<{ uuid: string; promptCount: number }> {
  let transcript: SessionMessage[];
  try {
    transcript = await getSessionMessages(params.sessionId, { dir: params.cwd });
  } catch (err) {
    onError('transcript_read_failed', (err as Error)?.message);
  }
  const promptMessages = transcript.filter(isPromptUserMessage);
  const targetSdkMsg = promptMessages[params.userMsgIndex];
  if (!targetSdkMsg?.uuid) {
    onError('sdk_message_not_found', `index=${params.userMsgIndex}`);
  }
  return { uuid: targetSdkMsg.uuid, promptCount: promptMessages.length };
}
