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
import { errorMessage } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { isString } from '../../lib/value-guards.js';
import {
  augmentPromptWithFiles,
  hydrateReferencedFiles,
  augmentPromptWithSymbols,
  stripInlineReferencedContent,
  type FileRef,
  type SymbolRef,
} from '../../utils/file-mentions.js';
import { imageAttachmentSchema } from '../../validation/schemas.js';
import { resolveAgentResources } from '../agent-resources/resolver.js';
import {
  startAgent,
  stopAgent,
  isAgentRunning,
  getSupportedSlashCommands,
} from '../agent-runner-control.js';
import { cleanupExternalThread } from '../ingest-mapper.js';
import { invalidateThreadCache } from '../remote-thread-data-client.js';
import type { RuntimeThreadUpdate } from '../server-interfaces.js';
import { getServices } from '../service-registry.js';
import { resolveThreadCwd } from '../thread-context.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import {
  ThreadServiceError,
  emitThreadUpdated,
  toThreadServiceError,
  releaseStagedUploadsOnSuccess,
  withStagedUploads,
} from './helpers.js';
import { augmentAllowedToolsWithRules } from './messaging-approvals.js';
import {
  executeShellEscape,
  extractShellEscapeCommand,
  formatShellEscapeOutput,
} from './shell-escape.js';

export { approveToolCall, respondPermissionRequest } from './messaging-approvals.js';

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
  /** Ids from POST /api/uploads/staging (composer had no thread id yet). */
  stagedUploads?: string[];
  baseBranch?: string;
  forceQueue?: boolean;
  /**
   * An earlier prompt the agent never answered (a sandbox whose setup failed).
   * The agent sees it before `content`; it is already persisted as its own
   * message, so only `content` is saved here.
   */
  precedingPrompt?: string;
  /** The images of `precedingPrompt`: sent to the agent, already saved with it. */
  precedingImages?: ImageAttachment[];
  /**
   * The id of this message, already saved by the server (a sandbox thread's
   * first message, saved when the thread was created). Reused instead of
   * inserting a duplicate when it is still the thread's latest user message.
   */
  savedMessageId?: string;
}

export interface SendMessageResult {
  ok: true;
  queued?: boolean;
  queuedCount?: number;
  queuedMessageId?: string;
  handledLocally?: 'shell_escape';
}

export function sendMessage(
  params: SendMessageParams,
): ResultAsync<SendMessageResult, ThreadServiceError> {
  return ResultAsync.fromPromise(sendMessageImpl(params), toThreadServiceError).map(
    releaseStagedUploadsOnSuccess(params),
  );
}

type SendThread = NonNullable<Awaited<ReturnType<typeof tm.getThread>>>;
type SendProject = Awaited<ReturnType<ReturnType<typeof getServices>['projects']['getProject']>>;

async function sendMessageImpl(rawParams: SendMessageParams): Promise<SendMessageResult> {
  // Read the thread fresh: the server may have just changed it (a sandbox thread
  // leaves `setting_up` right before its first message), and a stale copy would
  // make startAgent write the old status back.
  invalidateThreadCache(rawParams.threadId);
  const thread = await tm.getThread(rawParams.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  log.info('sendMessage called', {
    namespace: 'thread-service',
    threadId: rawParams.threadId,
    userId: thread.userId ?? rawParams.userId ?? 'unknown',
    projectId: thread.projectId,
    threadStatus: thread.status,
    sessionId: thread.sessionId ?? '',
    agentRunning: String(isAgentRunning(rawParams.threadId)),
    contentPreview: rawParams.content.slice(0, 120),
  });

  // Resolve cwd through the single source of truth (covers scratch / worktree /
  // normal threads). Fetch the project once and reuse for followUpMode below.
  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(thread, project ? { path: project.path } : null);
  if (cwdResult.isErr()) throw new ThreadServiceError(cwdResult.error.message, 400);
  const cwd = cwdResult.value;
  let params = await withStagedUploads(rawParams, rawParams.threadId, cwd);

  const shellCommand = extractShellEscapeCommand(params.content);
  if (shellCommand !== null) {
    return handleShellEscapeMessage(params, thread, cwd, shellCommand);
  }

  const effectiveProvider: AgentProvider = params.provider || thread.provider || DEFAULT_PROVIDER;
  // SAFETY: params.model passed agentModelSchema at the route and threads.model was
  // validated the same way when written; ids of dynamic-catalog providers (pi, cursor, ...)
  // are not in the AgentModel union and are passed through unchanged by resolveModelId.
  const effectiveModel = (params.model || thread.model || DEFAULT_MODEL) as AgentModel;
  const agentContent = await resolveSlashCommandContent(
    params,
    thread,
    cwd,
    effectiveProvider,
    effectiveModel,
  );

  // SAFETY: params.permissionMode passed permissionModeSchema at the route and
  // threads.permission_mode is only written from such input: exactly PermissionMode values.
  let effectivePermission = (params.permissionMode ||
    thread.permissionMode ||
    'autoEdit') as PermissionMode;

  await applyThreadSettingChanges(params, thread);
  const promotion = await startIdleThreadIfNeeded(params, thread);
  params = promotion.params;
  let hasDraftMessage = promotion.hasDraft;

  const { augmentedContent, persistedContent } = await buildMessageContents(
    params,
    agentContent,
    cwd,
  );

  const { willQueue, steer } = decideFollowUpDelivery(params, thread, project, effectiveProvider);

  if (willQueue) {
    return enqueueFollowUp(params, thread, {
      content: augmentedContent,
      provider: effectiveProvider,
      model: effectiveModel,
      permissionMode: effectivePermission,
    });
  }

  // Persist the user's message BEFORE any remote/long-running call. If a later
  // step (e.g. findLastUnansweredInteractiveToolCall) times out or throws, the
  // user's content is already saved — refresh shows the message instead of
  // appearing to lose it silently. Downstream code (startAgent) is told the
  // message already exists via hasDraftMessage=true.
  await persistFollowUpMessage(params, {
    hasDraftMessage,
    content: persistedContent,
    model: effectiveModel,
    permissionMode: effectivePermission,
  });
  hasDraftMessage = true;
  effectivePermission = await resolvePendingInteractiveToolCall(
    params,
    thread,
    effectivePermission,
  );

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
    agentImages(params),
    params.disallowedTools,
    allowedToolsForRun,
    effectiveProvider,
    undefined,
    hasDraftMessage, // skipMessageInsert — draft already exists
    params.effort,
    steer,
  ).mapErr((error) => {
    log.error('Failed to start agent in background', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: error.message,
    });
  });

  return { ok: true };
}

/**
 * Validate a pure slash command against the provider's known commands and
 * rewrite it into the prompt the agent should receive. Uses the composer's
 * provider-scoped catalog as well as live session commands — a previous
 * provider's session list cannot validate a newly selected provider.
 */
async function resolveSlashCommandContent(
  params: SendMessageParams,
  thread: SendThread,
  cwd: string,
  effectiveProvider: AgentProvider,
  effectiveModel: AgentModel,
): Promise<string> {
  if (!isPureSlashCommand(params.content)) return params.content;
  const name = extractSlashCommandName(params.content)!;
  const known = liveSlashCommands(params.threadId, thread, effectiveProvider);
  if (known?.has(name)) return params.content;

  const resource = await findComposerResource(params, thread, cwd, {
    name,
    provider: effectiveProvider,
    model: effectiveModel,
  });
  if (resource?.kind === 'skill' && effectiveProvider === 'codex') {
    return codexSkillPrompt(params.content, name);
  }
  if (!resource) assertNotKnownToSession(name, known);
  return params.content;
}

/** Live session commands — only valid for the provider that owns the session. */
function liveSlashCommands(
  threadId: string,
  thread: SendThread,
  effectiveProvider: AgentProvider,
): Set<string> | undefined {
  return effectiveProvider === thread.provider ? getSupportedSlashCommands(threadId) : undefined;
}

/** Codex has no slash skills — rewrite `/skill args` into a natural prompt. */
function codexSkillPrompt(content: string, name: string): string {
  const args = content
    .trimStart()
    .slice(name.length + 1)
    .trimStart();
  return `Use the ${name} skill.${args ? `\n\n${args}` : ''}`;
}

/** Refuse to send a command the live session reports it doesn't support. */
function assertNotKnownToSession(name: string, known: Set<string> | undefined): void {
  if (known && known.size > 0) {
    throw new ThreadServiceError(
      `Unknown slash command "/${name}". It is not available in this session, so it was not sent.`,
      400,
    );
  }
}

/** Look up a skill / slash-command resource by name in the composer catalog. */
async function findComposerResource(
  params: SendMessageParams,
  thread: SendThread,
  cwd: string,
  query: { name: string; provider: AgentProvider; model: AgentModel },
) {
  const profile =
    query.provider === 'claude' && thread.projectId
      ? await getServices().agentProfiles.resolveEffectiveProfile(thread.projectId, params.userId)
      : undefined;
  const resolved = await resolveAgentResources({
    provider: query.provider,
    model: query.model,
    phase: 'composer',
    projectPath: cwd,
    projectId: thread.projectId,
    claudeConfigDir:
      profile?.profile?.provider === 'claude' ? profile.env.CLAUDE_CONFIG_DIR : undefined,
  });
  if (resolved.isErr()) throw new ThreadServiceError(resolved.error.message, 500);
  return resolved.value.resources.find(
    (r) => r.name === query.name && (r.kind === 'skill' || r.kind === 'slash-command'),
  );
}

/** True when the caller supplied a value that differs from the stored one. */
function isChanged(next: string | undefined, current: string | null | undefined): boolean {
  return !!(next && next !== current);
}

/** Collect permission mode, model, provider, and baseBranch changes. */
function collectThreadSettingUpdates(
  params: SendMessageParams,
  thread: SendThread,
): RuntimeThreadUpdate {
  const updates: RuntimeThreadUpdate = {};
  const modelChanged = isChanged(params.model, thread.model);
  const providerChanged = isChanged(params.provider, thread.provider);

  if (isChanged(params.permissionMode, thread.permissionMode)) {
    updates.permissionMode = params.permissionMode;
  }
  if (modelChanged) {
    updates.model = params.model;
  }
  if (providerChanged) {
    updates.provider = params.provider;
  }
  if (isChanged(params.baseBranch, thread.baseBranch)) {
    updates.baseBranch = params.baseBranch;
  }
  // Clear sessionId when model or provider changes — the old session is incompatible
  if ((modelChanged || providerChanged) && thread.sessionId) {
    updates.sessionId = null;
    updates.contextRecoveryReason = providerChanged ? 'provider_changed' : 'model_changed';
  }
  return updates;
}

/** Persist permission mode, model, provider, and baseBranch if they changed. */
async function applyThreadSettingChanges(
  params: SendMessageParams,
  thread: SendThread,
): Promise<void> {
  const updates = collectThreadSettingUpdates(params, thread);
  if (Object.keys(updates).length > 0) {
    await tm.updateThread(params.threadId, updates);
  }
}

/**
 * The first message of a never-started (idle) thread starts it: the thread
 * moves to in_progress (from backlog, planning, or a board move that already
 * set the stage) and its user draft is reused instead of duplicated.
 */
async function promoteIdleThread(
  params: SendMessageParams,
  thread: SendThread,
): Promise<{ hasDraft: boolean; draftImages?: ImageAttachment[] }> {
  if (thread.status !== 'idle') return { hasDraft: false };

  const stageUpdates: RuntimeThreadUpdate = {};
  if (thread.stage !== 'in_progress') stageUpdates.stage = 'in_progress';
  if (!thread.initialPrompt || params.content !== thread.initialPrompt) {
    stageUpdates.title = params.content.slice(0, 200);
    stageUpdates.initialPrompt = params.content;
  }
  if (Object.keys(stageUpdates).length > 0) await tm.updateThread(params.threadId, stageUpdates);

  const { messages: draftMessages } = await tm.getThreadMessages({
    threadId: params.threadId,
    limit: 1,
  });
  const draftMsg = draftMessages[0];
  if (!draftMsg || draftMsg.role !== 'user') return { hasDraft: false };
  return { hasDraft: true, draftImages: parseDraftImages(draftMsg.images) };
}

/**
 * Promote an idle thread and carry its draft along: images attached to the
 * draft come with the first send unless it brings its own.
 */
/**
 * Whether `savedMessageId` names this thread's latest message, a user one, so
 * it is reused (as a draft is) instead of saved again. Any other id — another
 * thread's message, or one with later messages after it — is ignored.
 */
async function isSavedLatestUserMessage(params: SendMessageParams): Promise<boolean> {
  if (!params.savedMessageId) return false;
  const { messages } = await tm.getThreadMessages({ threadId: params.threadId, limit: 1 });
  const latest = messages[0];
  return latest?.id === params.savedMessageId && latest.role === 'user';
}

async function startIdleThreadIfNeeded(
  params: SendMessageParams,
  thread: SendThread,
): Promise<{ params: SendMessageParams; hasDraft: boolean }> {
  const promoted = await promoteIdleThread(params, thread);
  const { draftImages } = promoted;
  const hasDraft = promoted.hasDraft || (await isSavedLatestUserMessage(params));
  if (params.images?.length || !draftImages?.length) return { params, hasDraft };
  return { params: { ...params, images: draftImages }, hasDraft };
}

/** A draft message's images: already decoded, or the stored JSON text. */
type StoredDraftImages = ImageAttachment[] | string | null | undefined;

function parseDraftImages(raw: StoredDraftImages): ImageAttachment[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!isString(raw) || !raw) return undefined;
  const parsed = parseStoredJson(z.array(imageAttachmentSchema), raw, 'draft message images');
  return parsed.ok ? parsed.value : undefined;
}

/** The images the agent sees: the earlier prompt's (sandbox retry), then the message's. */
function agentImages(params: SendMessageParams): ImageAttachment[] | undefined {
  if (!params.precedingImages?.length) return params.images;
  return [...params.precedingImages, ...(params.images ?? [])];
}

/** The agent sees a never-answered earlier prompt (sandbox retry) before the message. */
function withPrecedingPrompt(params: SendMessageParams, content: string): string {
  return params.precedingPrompt ? `${params.precedingPrompt}\n\n${content}` : content;
}

/**
 * Augment the prompt with file/symbol contents — this is what the agent sees.
 * What we persist in the messages table is the path-only metadata version
 * (derived from the user's original text), so the UI shows file chips instead
 * of inlining the entire source.
 */
async function buildMessageContents(
  params: SendMessageParams,
  agentContent: string,
  cwd: string,
): Promise<{ augmentedContent: string; persistedContent: string }> {
  const augmentReferences = async (text: string) => {
    // Path-only entries come from a backlog thread's stored prompt.
    const hydrated = await hydrateReferencedFiles(text, cwd);
    const withFiles = await augmentPromptWithFiles(hydrated, params.fileReferences, cwd);
    return augmentPromptWithSymbols(withFiles, params.symbolReferences, cwd);
  };
  let augmentedContent = await augmentReferences(params.content);
  const persistedContent = stripInlineReferencedContent(augmentedContent);
  if (agentContent !== params.content) {
    augmentedContent = await augmentReferences(agentContent);
  }
  return { augmentedContent: withPrecedingPrompt(params, augmentedContent), persistedContent };
}

/**
 * Decide whether this send will be queued or steer the live turn. When
 * queued, the user message is deliberately NOT persisted to `messages` — it
 * lives only in the queue table until dequeue, where startAgent inserts it
 * with a timestamp that matches when the agent actually starts processing it.
 * This avoids the double-render bug where the stored message and the
 * client-side dequeue buffer both surface the same content twice.
 */
function decideFollowUpDelivery(
  params: SendMessageParams,
  thread: SendThread,
  project: SendProject | null,
  effectiveProvider: AgentProvider,
): { willQueue: boolean; steer: boolean } {
  const followUpMode = followUpModeFor(project);
  const turnInFlight = isTurnInFlight(params.threadId, thread.status);

  // Interrupting a Claude turn mid-thinking (steer's query.interrupt() or
  // interrupt mode's kill+respawn) leaves a partial `thinking` block that
  // poisons session resume — the Anthropic 400 "thinking blocks ... cannot be
  // modified". The risk scales with thinking depth, so for heavy-thinking
  // efforts we queue the follow-up instead, letting the turn finish cleanly
  // rather than being cut. (Lighter efforts keep steer/interrupt; the session
  // self-recovers via isThinkingBlockError if a poison still slips through.)
  const avoidInterrupt = turnInFlight && isHeavyThinking(effectiveProvider, params.effort);
  if (avoidInterrupt) logQueuedToAvoidInterrupt(params, followUpMode);

  const willQueue =
    turnInFlight && (followUpMode === 'queue' || !!params.forceQueue || avoidInterrupt);

  // Steer: only when the agent is actively mid-turn (not waiting on an
  // interactive answer, not terminal). When the thread is idle the message is
  // a normal follow-up (warm-continue on the live session, or resume).
  const steer = followUpMode === 'steer' && turnInFlight && !avoidInterrupt;
  return { willQueue, steer };
}

const TERMINAL_THREAD_STATUSES = new Set(['stopped', 'completed', 'failed']);

function followUpModeFor(project: SendProject | null): string {
  return project?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
}

/**
 * A turn is genuinely in flight only when the agent is running and not paused
 * on an interactive answer (waiting) or already terminal.
 */
function isTurnInFlight(threadId: string, status: string | null | undefined): boolean {
  const agentRunning = isAgentRunning(threadId);
  return agentRunning && status !== 'waiting' && !TERMINAL_THREAD_STATUSES.has(status ?? '');
}

function isHeavyThinking(provider: AgentProvider, effort: string | undefined): boolean {
  return provider === 'claude' && (effort === 'xhigh' || effort === 'max');
}

function logQueuedToAvoidInterrupt(params: SendMessageParams, followUpMode: string): void {
  if (followUpMode === 'queue') return;
  log.info('Queuing follow-up to avoid interrupting a heavy-thinking turn', {
    namespace: 'thread-service',
    threadId: params.threadId,
    followUpMode,
    effort: params.effort ?? '',
  });
}

function jsonOrUndefined<T extends object>(value: T | undefined): string | undefined {
  return value ? JSON.stringify(value) : undefined;
}

/** Broadcast the current queue size + next message preview; returns the size. */
async function broadcastQueueUpdate(threadId: string, userId: string | undefined): Promise<number> {
  const qCount = await getServices().messageQueue.queueCount(threadId);
  const nextMsg = await getServices().messageQueue.peek(threadId);
  const queueEvent = {
    type: 'thread:queue_update' as const,
    threadId,
    data: { threadId, queuedCount: qCount, nextMessage: nextMsg?.content?.slice(0, 100) },
  } satisfies WSEvent;
  if (userId) {
    wsBroker.emitToUser(userId, queueEvent);
  } else {
    wsBroker.emit(queueEvent);
  }
  return qCount;
}

/** Queue the follow-up for the running turn and broadcast the new queue state. */
async function enqueueFollowUp(
  params: SendMessageParams,
  thread: SendThread,
  run: {
    content: string;
    provider: AgentProvider;
    model: AgentModel;
    permissionMode: PermissionMode;
  },
): Promise<SendMessageResult> {
  const queued = await getServices().messageQueue.enqueue(params.threadId, {
    content: run.content,
    provider: run.provider,
    model: run.model,
    permissionMode: run.permissionMode,
    images: jsonOrUndefined(agentImages(params)),
    allowedTools: jsonOrUndefined(params.allowedTools),
    disallowedTools: jsonOrUndefined(params.disallowedTools),
    fileReferences: jsonOrUndefined(params.fileReferences),
  });

  const qCount = await broadcastQueueUpdate(params.threadId, thread.userId);
  return { ok: true, queued: true, queuedCount: qCount, queuedMessageId: queued.id };
}

/**
 * Save the user's follow-up message — updating the existing draft when there
 * is one. Afterwards the message always exists, so startAgent must skip its
 * own insert.
 */
async function persistFollowUpMessage(
  params: SendMessageParams,
  msg: {
    hasDraftMessage: boolean;
    content: string;
    model: AgentModel;
    permissionMode: PermissionMode;
  },
): Promise<void> {
  const images = params.images?.length ? JSON.stringify(params.images) : null;
  if (msg.hasDraftMessage) {
    const { messages: draftMsgs } = await tm.getThreadMessages({
      threadId: params.threadId,
      limit: 1,
    });
    if (draftMsgs[0]) {
      await tm.updateMessage(draftMsgs[0].id, { content: msg.content, images });
    }
    return;
  }
  await tm.insertMessage({
    threadId: params.threadId,
    role: 'user',
    content: msg.content,
    images,
    model: msg.model,
    permissionMode: msg.permissionMode,
    effort: params.effort ?? null,
  });
}

/**
 * Persist the user's answer in the tool call output and return the permission
 * mode to run with.
 *
 * Always attempted (not just when status === 'waiting') because the thread
 * status may have already transitioned away from 'waiting' by the time the
 * user's response arrives — e.g. due to interruption or race conditions.
 * Without this, the tool call output stays NULL and the UI re-shows
 * accept/reject buttons on refresh. Failures are logged and never lose the
 * user's message (already persisted).
 */
async function resolvePendingInteractiveToolCall(
  params: SendMessageParams,
  thread: SendThread,
  permissionMode: PermissionMode,
): Promise<PermissionMode> {
  let effectivePermission = permissionMode;
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
        await upgradePlanToAutoEdit(params.threadId, thread.userId);
      }
    }
  } catch (err) {
    log.warn('sendMessage: failed to resolve pending interactive tool call (continuing)', {
      namespace: 'thread-service',
      threadId: params.threadId,
      error: errorMessage(err),
    });
  }
  return effectivePermission;
}

async function upgradePlanToAutoEdit(threadId: string, userId: string): Promise<void> {
  await tm.updateThread(threadId, { permissionMode: 'autoEdit' });
  emitThreadUpdated(userId, threadId, { permissionMode: 'autoEdit' });
  log.info('sendMessage: upgrading permissionMode from plan to autoEdit after ExitPlanMode', {
    namespace: 'thread-service',
    threadId,
  });
}

async function handleShellEscapeMessage(
  params: SendMessageParams,
  thread: SendThread,
  cwd: string,
  command: string,
): Promise<SendMessageResult> {
  if (!command) {
    throw new ThreadServiceError('Shell escape requires a command after "!".', 400);
  }
  if (thread.userId && params.userId && thread.userId !== params.userId) {
    throw new ThreadServiceError('Only the thread owner can run shell escapes.', 403);
  }

  const userMessageId = await tm.insertMessage({
    threadId: params.threadId,
    role: 'user',
    content: params.content,
    images: params.images?.length ? JSON.stringify(params.images) : null,
    model: params.model ?? thread.model ?? null,
    permissionMode: params.permissionMode ?? thread.permissionMode ?? null,
    effort: params.effort ?? null,
  });

  const assistantMessageId = await tm.insertMessage({
    threadId: params.threadId,
    role: 'assistant',
    content: '',
  });
  const toolInput = { command };
  const toolCallId = await tm.insertToolCall({
    messageId: assistantMessageId,
    name: 'Bash',
    input: JSON.stringify(toolInput),
    author: 'shell',
  });

  const result = await executeShellEscape(command, cwd);
  const output = formatShellEscapeOutput(result);
  await tm.updateToolCallOutput(toolCallId, output);

  const emitMessage = (data: { messageId: string; role: string; content: string }) => {
    const event = { type: 'agent:message' as const, threadId: params.threadId, data };
    if (thread.userId) wsBroker.emitToUser(thread.userId, event);
    else wsBroker.emit(event);
  };
  const emitTool = (
    event:
      | {
          type: 'agent:tool_call';
          data: {
            toolCallId: string;
            messageId: string;
            name: string;
            input: typeof toolInput;
            author: string;
          };
        }
      | { type: 'agent:tool_output'; data: { toolCallId: string; output: string } },
  ) => {
    const wsEvent = { ...event, threadId: params.threadId };
    if (thread.userId) wsBroker.emitToUser(thread.userId, wsEvent);
    else wsBroker.emit(wsEvent);
  };

  emitMessage({ messageId: userMessageId, role: 'user', content: params.content });
  emitTool({
    type: 'agent:tool_call',
    data: {
      toolCallId,
      messageId: assistantMessageId,
      name: 'Bash',
      input: toolInput,
      author: 'shell',
    },
  });
  emitTool({
    type: 'agent:tool_output',
    data: { toolCallId, output },
  });

  return { ok: true, handledLocally: 'shell_escape' };
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
  const stopped = await stopAgent(threadId);
  if (stopped.isErr()) throw new ThreadServiceError(stopped.error.message, 500);
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
  const qCount = await broadcastQueueUpdate(threadId, thread?.userId);

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
  const qCount = await broadcastQueueUpdate(threadId, thread?.userId);

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
