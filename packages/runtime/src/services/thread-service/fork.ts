/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 *
 * Fork a thread at a specific user message, natively in funny: the prefix of
 * DB messages and tool calls up to (and including) that message is mirrored
 * into a new idle thread. No provider session is forked — the provider SDKs
 * locate transcripts by their own config dir / storage layout, which funny
 * cannot reliably reach (e.g. a Claude profile with a custom
 * CLAUDE_CONFIG_DIR). Instead the fork is marked for context recovery, so its
 * first follow-up starts a fresh session seeded with the copied transcript —
 * the same path used after interruptions and model/provider changes. The
 * source's Git checkpoints are re-pointed at the copied messages, so the fork
 * can still rewind to the turns it inherited.
 */

import { nanoid } from 'nanoid';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric, startSpan } from '../../lib/telemetry.js';
import { copyGitCheckpoint } from '../git-checkpoints.js';
import { getServices } from '../service-registry.js';
import { canDoGitOps } from '../thread-context.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { ThreadServiceError } from './helpers.js';

export interface ForkThreadParams {
  sourceThreadId: string;
  messageId: string;
  userId: string;
  title?: string;
}

export function forkThread(
  params: ForkThreadParams,
): ResultAsync<Awaited<ReturnType<typeof forkThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(forkThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function forkThreadImpl(params: ForkThreadParams) {
  const span = startSpan('thread.fork', {
    attributes: { threadId: params.sourceThreadId },
  });

  const source = await tm.getThread(params.sourceThreadId);
  if (!source || source.userId !== params.userId) {
    span.end('error', 'thread_not_found');
    throw new ThreadServiceError('Thread not found', 404);
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
    // No provider session to resume: rebuild the copied transcript on the
    // first follow-up so the fork is a functional branch, not just a copy of
    // the source conversation in the UI.
    sessionId: null,
    contextRecoveryReason: 'forked',
    parentThreadId: source.id,
    // Set once the source's checkpoints are copied below.
    fileCheckpointingEnabled: 0,
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
  await tm.createThread(newThread);

  // Mirror the prefix of DB messages (and their tool calls) into the new thread
  const messagesToCopy: any[] = dbMessages.slice(0, targetIdx + 1);
  const toolCallIdMap = new Map<string, string>();
  let copiedCheckpoints = 0;

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

    if (
      m.role === 'user' &&
      source.fileCheckpointingEnabled &&
      canDoGitOps({ isScratch: !!source.isScratch })
    ) {
      const copied = await copyGitCheckpoint({
        cwd,
        from: { threadId: source.id, messageId: m.id },
        to: { threadId: newThreadId, messageId: newMsgId },
      }).catch((err) => {
        log.warn('Failed to copy Git checkpoint to fork', {
          namespace: 'thread-fork',
          threadId: source.id,
          messageId: m.id,
          error: (err as Error)?.message,
        });
        return false;
      });
      if (copied) copiedCheckpoints++;
    }
  }

  if (copiedCheckpoints > 0) {
    newThread.fileCheckpointingEnabled = 1;
    await tm.updateThread(newThreadId, { fileCheckpointingEnabled: 1 });
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
    forkedAtMessageId: params.messageId,
    provider: source.provider ?? 'claude',
    copiedMessageCount: messagesToCopy.length,
    copiedCheckpoints,
  });
  metric('threads.forked', 1, { type: 'sum' });
  span.end('ok');

  return newThread;
}
