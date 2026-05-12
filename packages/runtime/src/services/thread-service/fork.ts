/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 *
 * Fork a thread at a specific user message. For Claude threads, uses the
 * Claude Agent SDK's native `forkSession()` to slice the SDK transcript at
 * the matching transcript message UUID. For ACP-based providers (codex,
 * gemini, pi), spawns the agent CLI briefly and calls ACP's
 * `unstable_forkSession()` if the capability is advertised. Otherwise the
 * fork is a "branch the visible conversation" with no native session
 * continuity. In all cases the prefix of DB messages and tool calls are
 * mirrored into a new (idle) thread.
 */

import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { forkAcpSession } from '@funny/core/agents';
import { nanoid } from 'nanoid';

import { log } from '../../lib/logger.js';
import { metric, startSpan } from '../../lib/telemetry.js';
import { getServices } from '../service-registry.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { ThreadServiceError } from './helpers.js';

const ACP_PROVIDERS = new Set(['codex', 'gemini', 'pi']);

export interface ForkThreadParams {
  sourceThreadId: string;
  messageId: string;
  userId: string;
  title?: string;
}

/** A SessionMessage from the SDK whose `message` payload is a real user prompt
 *  (not a tool_result). Tool result entries are also `type: 'user'` in the
 *  transcript, so we filter them out by inspecting content blocks. */
function isPromptUserMessage(sm: SessionMessage): boolean {
  if (sm.type !== 'user') return false;
  const m = (sm as any).message;
  if (!m) return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return true;
  return !m.content.some((b: any) => b?.type === 'tool_result');
}

export async function forkThread(params: ForkThreadParams) {
  const span = startSpan('thread.fork', {
    attributes: { threadId: params.sourceThreadId },
  });

  const source = await tm.getThread(params.sourceThreadId);
  if (!source || source.userId !== params.userId) {
    span.end('error', 'thread_not_found');
    throw new ThreadServiceError('Thread not found', 404);
  }
  if (!source.sessionId) {
    span.end('error', 'no_session');
    throw new ThreadServiceError('Thread has no session to fork', 400);
  }

  const pathResult = await getServices().projects.resolveProjectPath(
    source.projectId,
    params.userId,
  );
  if (pathResult.isErr()) {
    span.end('error', pathResult.error.message);
    throw new ThreadServiceError(pathResult.error.message, 400);
  }
  const projectPath = pathResult.value;
  const cwd = source.worktreePath ?? projectPath;

  // Load all DB messages with their tool calls
  const detail = await tm.getThreadWithMessages(params.sourceThreadId);
  const dbMessages = detail?.messages ?? [];

  const targetIdx = dbMessages.findIndex((m: any) => m.id === params.messageId);
  if (targetIdx < 0) {
    span.end('error', 'message_not_found');
    throw new ThreadServiceError('Message not found in thread', 404);
  }
  const targetMsg: any = dbMessages[targetIdx];
  if (targetMsg.role !== 'user') {
    span.end('error', 'not_user_message');
    throw new ThreadServiceError('Can only fork at a user message', 400);
  }

  // Index of the target user message among role==='user' rows
  const userMsgIndex =
    dbMessages.slice(0, targetIdx + 1).filter((m: any) => m.role === 'user').length - 1;

  // Determine native session-fork strategy by provider.
  // - claude (or unset): use the Claude SDK's transcript-aware forkSession()
  // - codex / gemini / pi: spawn the agent CLI briefly and call ACP unstable_forkSession()
  // - other providers: no native fork — copy DB messages with no sessionId
  let newSessionId: string | null = null;
  let forkedAtSdkUuid: string | undefined;
  const provider = source.provider ?? 'claude';

  if (provider === 'claude') {
    let transcript: SessionMessage[];
    try {
      transcript = await getSessionMessages(source.sessionId, { dir: cwd });
    } catch (err) {
      log.error('Failed to read SDK session transcript for fork', {
        namespace: 'thread-fork',
        threadId: source.id,
        sessionId: source.sessionId,
        cwd,
        error: (err as Error)?.message,
      });
      span.end('error', 'transcript_read_failed');
      throw new ThreadServiceError('Failed to read agent session transcript', 500);
    }

    const promptMessages = transcript.filter(isPromptUserMessage);
    const targetSdkMsg = promptMessages[userMsgIndex];
    if (!targetSdkMsg?.uuid) {
      log.error('No matching SDK transcript message for fork', {
        namespace: 'thread-fork',
        threadId: source.id,
        sessionId: source.sessionId,
        userMsgIndex,
        promptCount: promptMessages.length,
        transcriptCount: transcript.length,
      });
      span.end('error', 'sdk_message_not_found');
      throw new ThreadServiceError(
        'Could not locate matching message in agent session transcript',
        500,
      );
    }

    forkedAtSdkUuid = targetSdkMsg.uuid;

    try {
      const result = await forkSession(source.sessionId, {
        upToMessageId: targetSdkMsg.uuid,
        dir: cwd,
        title: params.title,
      });
      newSessionId = result.sessionId;
    } catch (err) {
      log.error('SDK forkSession failed', {
        namespace: 'thread-fork',
        threadId: source.id,
        sessionId: source.sessionId,
        cwd,
        error: (err as Error)?.message,
      });
      span.end('error', 'sdk_fork_failed');
      throw new ThreadServiceError('Failed to fork agent session', 500);
    }
  } else if (ACP_PROVIDERS.has(provider)) {
    const acpResult = await forkAcpSession({
      provider: provider as 'codex' | 'gemini' | 'pi',
      sessionId: source.sessionId,
      cwd,
    });
    if (acpResult.ok) {
      newSessionId = acpResult.newSessionId;
    } else {
      log.warn('ACP fork unavailable, falling back to DB-only branch copy', {
        namespace: 'thread-fork',
        threadId: source.id,
        provider,
        sessionId: source.sessionId,
        reason: acpResult.reason,
        message: acpResult.message,
      });
      metric('threads.fork_acp_fallback', 1, { type: 'sum' });
    }
  } else {
    log.info('Provider has no native session fork; copying DB messages only', {
      namespace: 'thread-fork',
      threadId: source.id,
      provider,
    });
  }

  // Create the new thread row
  const newThreadId = nanoid();
  const now = new Date().toISOString();
  const baseTitle = source.title || 'Conversation';
  const newThread: Record<string, any> = {
    id: newThreadId,
    projectId: source.projectId,
    userId: source.userId,
    title: params.title?.trim() || `Fork: ${baseTitle}`,
    mode: source.mode,
    runtime: source.runtime ?? 'local',
    provider: source.provider,
    permissionMode: source.permissionMode,
    model: source.model,
    source: 'fork',
    status: 'idle',
    stage: 'backlog',
    branch: source.branch,
    baseBranch: source.baseBranch,
    worktreePath: source.worktreePath,
    sessionId: newSessionId,
    parentThreadId: source.id,
    // Forked SDK sessions start without undo history (per the Claude SDK
    // docs), so even if the source thread had checkpointing on, the fork's
    // own future edits start a fresh checkpoint store.
    fileCheckpointingEnabled: provider === 'claude' ? 1 : 0,
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
  await tm.createThread(newThread);

  // Mirror the prefix of DB messages (and their tool calls) into the new thread
  const messagesToCopy: any[] = dbMessages.slice(0, targetIdx + 1);
  const toolCallIdMap = new Map<string, string>();

  for (const m of messagesToCopy) {
    const newMsgId = await tm.insertMessage({
      threadId: newThreadId,
      role: m.role,
      content: m.content,
      images: m.images ? JSON.stringify(m.images) : null,
      model: m.model ?? null,
      permissionMode: m.permissionMode ?? null,
      author: m.author ?? null,
    });

    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const remappedParent =
          tc.parentToolCallId && toolCallIdMap.has(tc.parentToolCallId)
            ? toolCallIdMap.get(tc.parentToolCallId)
            : null;
        const newToolCallId = await tm.insertToolCall({
          messageId: newMsgId,
          name: tc.name,
          input: tc.input ?? '',
          author: tc.author ?? null,
          parentToolCallId: remappedParent ?? null,
        });
        toolCallIdMap.set(tc.id, newToolCallId);
        if (typeof tc.output === 'string' && tc.output.length > 0) {
          await tm.updateToolCallOutput(newToolCallId, tc.output);
        }
      }
    }
  }

  threadEventBus.emit('thread:created', {
    threadId: newThreadId,
    projectId: source.projectId,
    userId: source.userId,
    cwd,
    worktreePath: source.worktreePath ?? null,
    stage: 'backlog' as const,
    status: 'idle',
  });

  log.info('Thread forked', {
    namespace: 'thread-fork',
    threadId: source.id,
    newThreadId,
    sessionId: source.sessionId,
    newSessionId,
    forkedAtMessageId: params.messageId,
    forkedAtSdkUuid,
    provider,
    copiedMessageCount: messagesToCopy.length,
  });
  metric('threads.forked', 1, { type: 'sum' });
  span.end('ok');

  return newThread;
}
