/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 */

import { isPureSlashCommand, extractSlashCommandName } from '@funny/core/agents';
import type {
  WSEvent,
  AgentProvider,
  AgentModel,
  PermissionMode,
  ImageAttachment,
} from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_FOLLOW_UP_MODE,
} from '@funny/shared/models';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import {
  augmentPromptWithFiles,
  augmentPromptWithSymbols,
  stripInlineReferencedContent,
  type FileRef,
  type SymbolRef,
} from '../../utils/file-mentions.js';
import {
  startAgent,
  stopAgent,
  isAgentRunning,
  getSupportedSlashCommands,
} from '../agent-runner.js';
import { cleanupExternalThread } from '../ingest-mapper.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { getServices } from '../service-registry.js';
import { resolveThreadCwd } from '../thread-context.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import { ThreadServiceError, emitThreadUpdated } from './helpers.js';

function toThreadServiceError(err: unknown): ThreadServiceError {
  return err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500);
}

/**
 * Augment a list of allowedTools with tool names that have an "always allow"
 * rule for the given user + project. Lets the agent skip permission prompts
 * for tools the user previously approved.
 *
 * Returns a new array; the original is not mutated.
 */
async function augmentAllowedToolsWithRules(
  userId: string,
  projectPath: string,
  allowedTools: string[] | undefined,
): Promise<string[] | undefined> {
  const rules = await listPermissionRules({ userId, projectPath });
  if (!rules.length) return allowedTools;
  const allowToolNames = new Set<string>();
  for (const rule of rules) {
    if (rule.decision === 'allow') {
      allowToolNames.add(rule.toolName);
    }
  }
  if (!allowToolNames.size) return allowedTools;
  const merged = new Set<string>(allowedTools ?? []);
  for (const t of allowToolNames) merged.add(t);
  return [...merged];
}

// ── Send Message / Follow-Up ────────────────────────────────────

export interface SendMessageParams {
  threadId: string;
  userId: string;
  content: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: FileRef[];
  symbolReferences?: SymbolRef[];
  baseBranch?: string;
  forceQueue?: boolean;
}

export interface SendMessageResult {
  ok: true;
  queued?: boolean;
  queuedCount?: number;
  queuedMessageId?: string;
}

export function sendMessage(
  params: SendMessageParams,
): ResultAsync<SendMessageResult, ThreadServiceError> {
  return ResultAsync.fromPromise(sendMessageImpl(params), toThreadServiceError);
}

// eslint-disable-next-line max-lines-per-function
async function sendMessageImpl(params: SendMessageParams): Promise<SendMessageResult> {
  const thread = await tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  // Guardrail: reject an unknown slash command up front instead of forwarding it
  // to the model as literal text. The SDK only executes a recognized /command;
  // a typo or non-existent command would otherwise silently turn into a prompt
  // the model "describes" — the same class of bug as /compact not compacting.
  // Only enforced when we actually captured the SDK's command list this process
  // lifetime (`undefined` ⇒ can't validate ⇒ allow through).
  if (isPureSlashCommand(params.content)) {
    const known = getSupportedSlashCommands(params.threadId);
    const name = extractSlashCommandName(params.content);
    if (known && known.size > 0 && name && !known.has(name)) {
      throw new ThreadServiceError(
        `Unknown slash command "/${name}". It is not available in this session, so it was not sent.`,
        400,
      );
    }
  }

  log.info('sendMessage called', {
    namespace: 'thread-service',
    threadId: params.threadId,
    userId: thread.userId ?? params.userId ?? 'unknown',
    projectId: thread.projectId,
    threadStatus: thread.status,
    sessionId: thread.sessionId ?? '',
    agentRunning: String(isAgentRunning(params.threadId)),
    contentPreview: params.content.slice(0, 120),
  });

  // Resolve cwd through the single source of truth (covers scratch / worktree /
  // normal threads). Fetch the project once and reuse for followUpMode below.
  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project ? { path: project.path } : null,
  );
  if (cwdResult.isErr()) throw new ThreadServiceError(cwdResult.error.message, 400);
  const cwd = cwdResult.value;

  const effectiveProvider = (params.provider ||
    thread.provider ||
    DEFAULT_PROVIDER) as AgentProvider;
  const effectiveModel = (params.model || thread.model || DEFAULT_MODEL) as AgentModel;
  let effectivePermission = (params.permissionMode ||
    thread.permissionMode ||
    'autoEdit') as PermissionMode;

  // Update thread's permission mode, model, provider, and baseBranch if they changed
  const updates: Record<string, any> = {};
  const modelChanged = !!(params.model && params.model !== thread.model);
  const providerChanged = !!(params.provider && params.provider !== thread.provider);

  if (params.permissionMode && params.permissionMode !== thread.permissionMode) {
    updates.permissionMode = params.permissionMode;
  }
  if (modelChanged) {
    updates.model = params.model;
  }
  if (providerChanged) {
    updates.provider = params.provider;
  }
  if (params.baseBranch && params.baseBranch !== thread.baseBranch) {
    updates.baseBranch = params.baseBranch;
  }
  // Clear sessionId when model or provider changes — the old session is incompatible
  if ((modelChanged || providerChanged) && thread.sessionId) {
    updates.sessionId = null;
    updates.contextRecoveryReason = providerChanged ? 'provider_changed' : 'model_changed';
  }
  if (Object.keys(updates).length > 0) {
    await tm.updateThread(params.threadId, updates);
  }

  // Auto-move idle backlog threads to in_progress when a message is sent.
  // Detect a pre-existing user draft so the persistence step below updates it
  // instead of inserting a duplicate.
  let hasDraftMessage = false;
  if (thread.status === 'idle' && thread.stage === 'backlog') {
    const stageUpdates: Record<string, any> = { stage: 'in_progress' };
    if (!thread.initialPrompt || params.content !== thread.initialPrompt) {
      stageUpdates.title = params.content.slice(0, 200);
      stageUpdates.initialPrompt = params.content;
    }
    await tm.updateThread(params.threadId, stageUpdates);

    const { messages: draftMessages } = await tm.getThreadMessages({
      threadId: params.threadId,
      limit: 1,
    });
    const draftMsg = draftMessages[0];
    if (draftMsg && draftMsg.role === 'user') {
      hasDraftMessage = true;
    }
  }

  // Augment prompt with file/symbol contents — this is what the agent sees.
  let augmentedContent = await augmentPromptWithFiles(params.content, params.fileReferences, cwd);
  augmentedContent = await augmentPromptWithSymbols(augmentedContent, params.symbolReferences, cwd);
  // What we persist in the messages table is the path-only metadata version,
  // so the UI shows file chips instead of inlining the entire source.
  const persistedContent = stripInlineReferencedContent(augmentedContent);

  // Decide whether this send will be queued. When queued, we deliberately
  // skip persisting the user message to `messages` here — the message lives
  // only in the queue table until dequeue, where startAgent inserts it with
  // a timestamp that matches when the agent actually starts processing it.
  // This avoids the double-render bug where the stored message and the
  // client-side dequeue buffer both surface the same content twice.
  const agentRunning = isAgentRunning(params.threadId);
  const followUpMode = project?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isWaitingResponse = thread.status === 'waiting';
  const threadIsTerminal =
    thread.status === 'stopped' || thread.status === 'completed' || thread.status === 'failed';
  // A turn is genuinely in flight only when the agent is running and not
  // paused on an interactive answer (waiting) or already terminal.
  const turnInFlight = agentRunning && !isWaitingResponse && !threadIsTerminal;

  // Interrupting a Claude turn mid-thinking (steer's query.interrupt() or
  // interrupt mode's kill+respawn) leaves a partial `thinking` block that
  // poisons session resume — the Anthropic 400 "thinking blocks ... cannot be
  // modified". The risk scales with thinking depth, so for heavy-thinking
  // efforts we queue the follow-up instead, letting the turn finish cleanly
  // rather than being cut. (Lighter efforts keep steer/interrupt; the session
  // self-recovers via isThinkingBlockError if a poison still slips through.)
  const heavyThinking =
    effectiveProvider === 'claude' && (params.effort === 'xhigh' || params.effort === 'max');
  const avoidInterrupt = turnInFlight && heavyThinking;
  if (avoidInterrupt && followUpMode !== 'queue') {
    log.info('Queuing follow-up to avoid interrupting a heavy-thinking turn', {
      namespace: 'thread-service',
      threadId: params.threadId,
      followUpMode,
      effort: params.effort ?? '',
    });
  }

  const willQueue =
    turnInFlight && (followUpMode === 'queue' || params.forceQueue || avoidInterrupt);

  // Steer: only when the agent is actively mid-turn (not waiting on an
  // interactive answer, not terminal). When the thread is idle the message is
  // a normal follow-up (warm-continue on the live session, or resume).
  const steer = followUpMode === 'steer' && turnInFlight && !avoidInterrupt;

  if (!willQueue) {
    // Persist the user's message BEFORE any remote/long-running call. If a later
    // step (e.g. findLastUnansweredInteractiveToolCall) times out or throws, the
    // user's content is already saved — refresh shows the message instead of
    // appearing to lose it silently. Downstream code (startAgent) is told the
    // message already exists via hasDraftMessage=true.
    if (hasDraftMessage) {
      const { messages: draftMsgs } = await tm.getThreadMessages({
        threadId: params.threadId,
        limit: 1,
      });
      if (draftMsgs[0]) {
        await tm.updateMessage(draftMsgs[0].id, {
          content: persistedContent,
          images: params.images?.length ? JSON.stringify(params.images) : null,
        });
      }
    } else {
      await tm.insertMessage({
        threadId: params.threadId,
        role: 'user',
        content: persistedContent,
        images: params.images?.length ? JSON.stringify(params.images) : null,
        model: effectiveModel,
        permissionMode: effectivePermission,
        effort: params.effort ?? null,
      });
      hasDraftMessage = true;
    }

    // Persist the user's answer in the tool call output.
    // Always attempt this (not just when status === 'waiting') because the thread
    // status may have already transitioned away from 'waiting' by the time the
    // user's response arrives — e.g. due to interruption or race conditions.
    // Without this, the tool call output stays NULL and the UI re-shows
    // accept/reject buttons on refresh.
    // Wrapped so a failure here doesn't lose the user's message (already persisted above).
    try {
      const pendingTC = await tm.findLastUnansweredInteractiveToolCall(params.threadId);
      if (pendingTC) {
        log.info('sendMessage: resolving unanswered interactive tool call', {
          namespace: 'thread-service',
          threadId: params.threadId,
          userId: thread.userId ?? 'unknown',
          projectId: thread.projectId,
          threadStatus: thread.status,
          pendingToolCallId: pendingTC.id,
          pendingToolCallName: pendingTC.name,
        });
        await tm.updateToolCallOutput(pendingTC.id, params.content);

        // When the user accepts a plan (ExitPlanMode), switch from plan-only mode
        // to autoEdit so the agent can actually execute. Without this, the agent
        // restarts in plan mode and immediately calls ExitPlanMode again — an
        // infinite loop.
        if (pendingTC.name === 'ExitPlanMode' && effectivePermission === 'plan') {
          effectivePermission = 'autoEdit';
          await tm.updateThread(params.threadId, { permissionMode: 'autoEdit' });
          emitThreadUpdated(thread.userId, params.threadId, { permissionMode: 'autoEdit' });
          log.info(
            'sendMessage: upgrading permissionMode from plan to autoEdit after ExitPlanMode',
            {
              namespace: 'thread-service',
              threadId: params.threadId,
            },
          );
        }
      }
    } catch (err) {
      log.warn('sendMessage: failed to resolve pending interactive tool call (continuing)', {
        namespace: 'thread-service',
        threadId: params.threadId,
        error: (err as Error).message,
      });
    }
  }

  if (willQueue) {
    const queued = await getServices().messageQueue.enqueue(params.threadId, {
      content: augmentedContent,
      provider: effectiveProvider,
      model: effectiveModel,
      permissionMode: effectivePermission,
      images: params.images ? JSON.stringify(params.images) : undefined,
      allowedTools: params.allowedTools ? JSON.stringify(params.allowedTools) : undefined,
      disallowedTools: params.disallowedTools ? JSON.stringify(params.disallowedTools) : undefined,
      fileReferences: params.fileReferences ? JSON.stringify(params.fileReferences) : undefined,
    });

    const qCount = await getServices().messageQueue.queueCount(params.threadId);
    const nextMsg = await getServices().messageQueue.peek(params.threadId);
    const queueEvent = {
      type: 'thread:queue_update' as const,
      threadId: params.threadId,
      data: {
        threadId: params.threadId,
        queuedCount: qCount,
        nextMessage: nextMsg?.content?.slice(0, 100),
      },
    } as WSEvent;
    if (thread.userId) {
      wsBroker.emitToUser(thread.userId, queueEvent);
    } else {
      wsBroker.emit(queueEvent);
    }

    return { ok: true, queued: true, queuedCount: qCount, queuedMessageId: queued.id };
  }

  // Default interrupt behavior — start agent (throws on failure)
  log.info('sendMessage: calling startAgent', {
    namespace: 'thread-service',
    threadId: params.threadId,
    userId: thread.userId ?? 'unknown',
    projectId: thread.projectId,
    threadStatusBefore: thread.status,
    hasDraftMessage: String(hasDraftMessage),
  });
  const allowedToolsForRun = await augmentAllowedToolsWithRules(
    params.userId,
    thread.worktreePath ?? cwd,
    params.allowedTools,
  );
  startAgent(
    params.threadId,
    augmentedContent,
    cwd,
    effectiveModel,
    effectivePermission,
    params.images,
    params.disallowedTools,
    allowedToolsForRun,
    effectiveProvider,
    undefined,
    hasDraftMessage, // skipMessageInsert — draft already exists
    params.effort,
    steer,
  ).catch((err) => {
    log.error('Failed to start agent in background', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: String(err),
    });
  });

  return { ok: true };
}

// ── Stop Thread ─────────────────────────────────────────────────

export function stopThread(threadId: string): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(stopThreadImpl(threadId), toThreadServiceError);
}

async function stopThreadImpl(threadId: string): Promise<void> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);
  if (thread.provider === 'external') {
    await cleanupExternalThread(threadId);
    return;
  }
  await stopAgent(threadId);
}

// ── Approve / Deny Tool ─────────────────────────────────────────

export interface ApproveToolParams {
  threadId: string;
  userId: string;
  toolName: string;
  approved: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** When 'always', persist a permission rule for this project. */
  scope?: 'once' | 'always';
  /** Optional explicit pattern; otherwise derived from toolInput for Bash. */
  pattern?: string;
  /** Original tool input (used to derive a Bash command prefix when needed). */
  toolInput?: string;
}

/** Heuristic: derive a Bash command prefix to use as a permission pattern. */
function deriveBashPrefix(toolInput: string | undefined): string | null {
  if (!toolInput) return null;
  const trimmed = toolInput.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || null;
}

export function approveToolCall(params: ApproveToolParams): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(approveToolCallImpl(params), toThreadServiceError);
}

async function approveToolCallImpl(params: ApproveToolParams): Promise<void> {
  const thread = await tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project ? { path: project.path } : null,
  );
  if (cwdResult.isErr()) throw new ThreadServiceError(cwdResult.error.message, 400);
  const cwd = cwdResult.value;

  const tools = params.allowedTools
    ? [...params.allowedTools]
    : [
        'Read',
        'Edit',
        'Write',
        'Bash',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TodoWrite',
        'NotebookEdit',
      ];

  const threadProvider = (thread.provider || DEFAULT_PROVIDER) as AgentProvider;

  if (params.approved) {
    if (!tools.includes(params.toolName)) {
      tools.push(params.toolName);
    }

    // Persist "always allow in this project" rule when requested.
    if (params.scope === 'always') {
      const pattern =
        params.pattern ?? (params.toolName === 'Bash' ? deriveBashPrefix(params.toolInput) : null);
      const projectPath = thread.worktreePath ?? cwd;
      try {
        const { createPermissionRule } = await import('../permission-rules-client.js');
        await createPermissionRule({
          userId: params.userId,
          projectPath,
          toolName: params.toolName,
          pattern,
          decision: 'allow',
        });
        log.info('approveToolCall: persisted always-allow rule', {
          namespace: 'thread-service',
          threadId: params.threadId,
          userId: params.userId,
          projectPath,
          toolName: params.toolName,
          pattern: pattern ?? '',
        });
      } catch (err) {
        // Don't block the approve flow on persistence failure; the
        // user can still re-approve next time.
        log.warn('approveToolCall: failed to persist always-allow rule', {
          namespace: 'thread-service',
          threadId: params.threadId,
          error: (err as Error)?.message,
        });
      }
    }
    const disallowed = params.disallowedTools?.filter((t) => t !== params.toolName);
    const projectPathForRules = thread.worktreePath ?? cwd;
    const augmentedTools = await augmentAllowedToolsWithRules(
      params.userId,
      projectPathForRules,
      tools,
    );
    const message = `The user has approved the use of ${params.toolName}. Please proceed with using it.`;
    await startAgent(
      params.threadId,
      message,
      cwd,
      (thread.model as AgentModel) || DEFAULT_MODEL,
      (thread.permissionMode as PermissionMode) || DEFAULT_PERMISSION_MODE,
      undefined,
      disallowed,
      augmentedTools,
      threadProvider,
    );
  } else {
    const message = `The user denied permission to use ${params.toolName}. Please continue without it.`;
    await startAgent(
      params.threadId,
      message,
      cwd,
      (thread.model as AgentModel) || DEFAULT_MODEL,
      (thread.permissionMode as PermissionMode) || DEFAULT_PERMISSION_MODE,
      undefined,
      params.disallowedTools,
      params.allowedTools,
      threadProvider,
    );
  }
}

// ── Queue Operations ────────────────────────────────────────────

export function cancelQueuedMessage(
  threadId: string,
  messageId: string,
): ResultAsync<{ queuedCount: number }, ThreadServiceError> {
  return ResultAsync.fromPromise(
    cancelQueuedMessageImpl(threadId, messageId),
    toThreadServiceError,
  );
}

async function cancelQueuedMessageImpl(
  threadId: string,
  messageId: string,
): Promise<{ queuedCount: number }> {
  const cancelled = await getServices().messageQueue.cancel(messageId);
  if (!cancelled) throw new ThreadServiceError('Queued message not found', 404);

  const thread = await tm.getThread(threadId);
  const qCount = await getServices().messageQueue.queueCount(threadId);
  const nextMsg = await getServices().messageQueue.peek(threadId);

  const queueEvent = {
    type: 'thread:queue_update' as const,
    threadId,
    data: { threadId, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
  } as WSEvent;
  if (thread?.userId) {
    wsBroker.emitToUser(thread.userId, queueEvent);
  } else {
    wsBroker.emit(queueEvent);
  }

  return { queuedCount: qCount };
}

export function updateQueuedMessage(
  threadId: string,
  messageId: string,
  content: string,
): ResultAsync<{ queuedCount: number; queuedMessage: any }, ThreadServiceError> {
  return ResultAsync.fromPromise(
    updateQueuedMessageImpl(threadId, messageId, content),
    toThreadServiceError,
  );
}

async function updateQueuedMessageImpl(
  threadId: string,
  messageId: string,
  content: string,
): Promise<{ queuedCount: number; queuedMessage: any }> {
  const queuedMessage = await getServices().messageQueue.update(messageId, content);
  if (!queuedMessage) throw new ThreadServiceError('Queued message not found', 404);

  const thread = await tm.getThread(threadId);
  const qCount = await getServices().messageQueue.queueCount(threadId);
  const nextMsg = await getServices().messageQueue.peek(threadId);

  const queueEvent = {
    type: 'thread:queue_update' as const,
    threadId,
    data: { threadId, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
  } as WSEvent;
  if (thread?.userId) {
    wsBroker.emitToUser(thread.userId, queueEvent);
  } else {
    wsBroker.emit(queueEvent);
  }

  return { queuedCount: qCount, queuedMessage };
}

// ── Comment Operations ──────────────────────────────────────────

export function deleteComment(
  threadId: string,
  commentId: string,
): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(deleteCommentImpl(threadId, commentId), toThreadServiceError);
}

async function deleteCommentImpl(threadId: string, commentId: string): Promise<void> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  await tm.deleteComment(commentId);

  const event = {
    type: 'thread:comment_deleted' as const,
    threadId,
    data: { commentId },
  };
  if (!thread.userId) {
    log.warn('deleteComment: thread has no userId — dropping WS event', {
      namespace: 'thread-service',
      threadId,
    });
  } else {
    wsBroker.emitToUser(thread.userId, event);
  }
}
