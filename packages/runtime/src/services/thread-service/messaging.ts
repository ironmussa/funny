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
import { resolveAgentResources } from '../agent-resources/resolver.js';
import {
  startAgent,
  stopAgent,
  isAgentRunning,
  getSupportedSlashCommands,
  getPendingPermission,
  respondToPermission,
} from '../agent-runner-control.js';
import { cleanupExternalThread } from '../ingest-mapper.js';
import { listPermissionRules } from '../permission-rules-client.js';
import { getServices } from '../service-registry.js';
import { resolveThreadCwd } from '../thread-context.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import { ThreadServiceError, emitThreadUpdated } from './helpers.js';
import {
  executeShellEscape,
  extractShellEscapeCommand,
  formatShellEscapeOutput,
} from './shell-escape.js';

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
  handledLocally?: 'shell_escape';
}

export function sendMessage(
  params: SendMessageParams,
): ResultAsync<SendMessageResult, ThreadServiceError> {
  return ResultAsync.fromPromise(sendMessageImpl(params), toThreadServiceError);
}

type SendThread = NonNullable<Awaited<ReturnType<typeof tm.getThread>>>;
type SendProject = Awaited<ReturnType<ReturnType<typeof getServices>['projects']['getProject']>>;

async function sendMessageImpl(params: SendMessageParams): Promise<SendMessageResult> {
  const thread = await tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

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

  const shellCommand = extractShellEscapeCommand(params.content);
  if (shellCommand !== null) {
    return handleShellEscapeMessage(params, thread, cwd, shellCommand);
  }

  const effectiveProvider = (params.provider ||
    thread.provider ||
    DEFAULT_PROVIDER) as AgentProvider;
  const effectiveModel = (params.model || thread.model || DEFAULT_MODEL) as AgentModel;
  const agentContent = await resolveSlashCommandContent(
    params,
    thread,
    cwd,
    effectiveProvider,
    effectiveModel,
  );

  let effectivePermission = (params.permissionMode ||
    thread.permissionMode ||
    'autoEdit') as PermissionMode;

  await applyThreadSettingChanges(params, thread);
  let hasDraftMessage = await promoteBacklogThread(params, thread);

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
function isChanged(next: string | undefined, current: unknown): boolean {
  return !!(next && next !== current);
}

/** Collect permission mode, model, provider, and baseBranch changes. */
function collectThreadSettingUpdates(
  params: SendMessageParams,
  thread: SendThread,
): Record<string, any> {
  const updates: Record<string, any> = {};
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
 * Auto-move idle backlog threads to in_progress when a message is sent.
 * Returns true when a pre-existing user draft was detected, so the
 * persistence step updates it instead of inserting a duplicate.
 */
async function promoteBacklogThread(
  params: SendMessageParams,
  thread: SendThread,
): Promise<boolean> {
  if (thread.status !== 'idle' || thread.stage !== 'backlog') return false;

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
  return !!draftMsg && draftMsg.role === 'user';
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
    const withFiles = await augmentPromptWithFiles(text, params.fileReferences, cwd);
    return augmentPromptWithSymbols(withFiles, params.symbolReferences, cwd);
  };
  let augmentedContent = await augmentReferences(params.content);
  const persistedContent = stripInlineReferencedContent(augmentedContent);
  if (agentContent !== params.content) {
    augmentedContent = await augmentReferences(agentContent);
  }
  return { augmentedContent, persistedContent };
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

function jsonOrUndefined(value: unknown): string | undefined {
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
  } as WSEvent;
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
    images: jsonOrUndefined(params.images),
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
      error: (err as Error).message,
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
  thread: Record<string, any>,
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
    if (thread.userId) wsBroker.emitToUser(thread.userId, event as WSEvent);
    else wsBroker.emit(event as WSEvent);
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
    const wsEvent = { ...event, threadId: params.threadId } as WSEvent;
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

export interface RespondPermissionRequestParams {
  threadId: string;
  userId: string;
  requestId: string;
  decision: import('@funny/shared').PermissionDecision;
}

/** Heuristic: derive a Bash command prefix to use as a permission pattern. */
function deriveBashPrefix(toolInput: string | undefined): string | null {
  if (!toolInput) return null;
  const trimmed = toolInput.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || null;
}

type ThreadRecord = NonNullable<Awaited<ReturnType<typeof tm.getThread>>>;
type PendingPermission = NonNullable<ReturnType<typeof getPendingPermission>>;

/** Tools granted on approval when the caller does not supply its own list. */
const DEFAULT_APPROVAL_TOOLS = [
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

async function requireThread(threadId: string): Promise<ThreadRecord> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);
  return thread;
}

/** Resolve the thread's working directory via the scratch-aware predicate. */
async function resolveWorkdir(thread: ThreadRecord): Promise<string> {
  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwdResult = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project ? { path: project.path } : null,
  );
  if (cwdResult.isErr()) throw new ThreadServiceError(cwdResult.error.message, 400);
  return cwdResult.value;
}

interface ApprovalRun {
  message: string;
  disallowedTools?: string[];
  allowedTools?: string[];
}

export function approveToolCall(params: ApproveToolParams): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(approveToolCallImpl(params), toThreadServiceError);
}

async function approveToolCallImpl(params: ApproveToolParams): Promise<void> {
  const thread = await requireThread(params.threadId);
  const cwd = await resolveWorkdir(thread);
  const run = params.approved
    ? await buildApprovedRun(params, thread, cwd)
    : buildDeniedRun(params);
  await startAgent(
    params.threadId,
    run.message,
    cwd,
    (thread.model as AgentModel) || DEFAULT_MODEL,
    (thread.permissionMode as PermissionMode) || DEFAULT_PERMISSION_MODE,
    undefined,
    run.disallowedTools,
    run.allowedTools,
    (thread.provider || DEFAULT_PROVIDER) as AgentProvider,
  );
}

function buildDeniedRun(params: ApproveToolParams): ApprovalRun {
  return {
    message: `The user denied permission to use ${params.toolName}. Please continue without it.`,
    disallowedTools: params.disallowedTools,
    allowedTools: params.allowedTools,
  };
}

async function buildApprovedRun(
  params: ApproveToolParams,
  thread: ThreadRecord,
  cwd: string,
): Promise<ApprovalRun> {
  const tools = params.allowedTools ? [...params.allowedTools] : [...DEFAULT_APPROVAL_TOOLS];
  if (!tools.includes(params.toolName)) {
    tools.push(params.toolName);
  }
  const projectPath = thread.worktreePath ?? cwd;
  // Persist "always allow in this project" rule when requested.
  if (params.scope === 'always') {
    await persistApprovalRule(params, projectPath);
  }
  return {
    message: `The user has approved the use of ${params.toolName}. Please proceed with using it.`,
    disallowedTools: params.disallowedTools?.filter((t) => t !== params.toolName),
    allowedTools: await augmentAllowedToolsWithRules(params.userId, projectPath, tools),
  };
}

function approvalRulePattern(params: ApproveToolParams): string | null {
  return params.pattern ?? (params.toolName === 'Bash' ? deriveBashPrefix(params.toolInput) : null);
}

async function persistApprovalRule(params: ApproveToolParams, projectPath: string): Promise<void> {
  const pattern = approvalRulePattern(params);
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

/**
 * Answer a provider-native request in the process that created it. This path
 * intentionally never calls startAgent: doing so would turn a per-tool choice
 * into a new natural-language prompt and could approve the wrong operation.
 */
export function respondPermissionRequest(
  params: RespondPermissionRequestParams,
): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(respondPermissionRequestImpl(params), toThreadServiceError);
}

async function respondPermissionRequestImpl(params: RespondPermissionRequestParams): Promise<void> {
  const thread = await requireThread(params.threadId);
  if (thread.userId !== params.userId) throw new ThreadServiceError('Access denied', 403);

  // The process lookup binds this decision to the current live request id and
  // supplies the only input that may be used to create an always-allow rule.
  const pending = getPendingPermission(params.threadId, params.requestId);
  if (!pending) throw new ThreadServiceError('This permission request is no longer active.', 409);

  if (params.decision === 'allow_always') {
    await persistStructuredAllowRule(params, thread, pending);
  }

  const accepted = await respondToPermission(params.threadId, params.requestId, params.decision);
  if (!accepted) throw new ThreadServiceError('This permission request is no longer active.', 409);

  await recordPermissionResolution(params);
  await markPermissionTurnResumed(params);
}

async function persistStructuredAllowRule(
  params: RespondPermissionRequestParams,
  thread: ThreadRecord,
  pending: PendingPermission,
): Promise<void> {
  const cwd = await resolveWorkdir(thread);
  const pattern = pending.toolName === 'Bash' ? deriveBashPrefix(pending.toolInput) : null;
  const { createPermissionRule } = await import('../permission-rules-client.js');
  const rule = await createPermissionRule({
    userId: params.userId,
    projectPath: thread.worktreePath ?? cwd,
    toolName: pending.toolName,
    pattern,
    decision: 'allow',
  });
  // The continuation is deliberately left live when persistence fails so
  // the card can offer a truthful one-time approval instead.
  if (!rule) {
    throw new ThreadServiceError(
      'Permanent approval could not be saved. You can still allow this action once.',
      503,
    );
  }
}

async function recordPermissionResolution(params: RespondPermissionRequestParams): Promise<void> {
  const persisted = await tm.resolvePendingPermissionRequest?.(params.requestId, params.decision);
  // The process accepts a request only once. Storage follows immediately so
  // reloads cannot revive the just-resolved card. A failed durable transition
  // is logged because the provider has already resumed and cannot be rolled
  // back safely.
  if (persisted === false) {
    log.warn('Structured permission resolved live but was already stale in storage', {
      namespace: 'thread-service',
      threadId: params.threadId,
      requestId: params.requestId,
    });
  }
}

async function markPermissionTurnResumed(params: RespondPermissionRequestParams): Promise<void> {
  // The provider is resuming the same live turn. Clear the actionable card
  // immediately instead of leaving the thread visibly waiting until its next
  // tool/result event arrives.
  await tm.updateThread(params.threadId, { status: 'running' });
  wsBroker.emitToUser(params.userId, {
    type: 'agent:status',
    threadId: params.threadId,
    data: {
      status: 'running',
      permissionApprovalCapability: { kind: 'structured', transport: 'codex-acp' },
    },
  });
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
