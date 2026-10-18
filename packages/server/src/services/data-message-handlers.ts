/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 *
 * Per-type executors for runner → server data messages. Callers MUST run the
 * ownership (`data-ownership.ts`) and project-scope (`data-scope.ts`) guards
 * before dispatching here — see `handleDataMessageWithAck` in data-handler.ts.
 */

import type { JobPatch, WatcherPatch } from '@funny/shared/repositories';
import { and, eq, or } from 'drizzle-orm';

import { db, dbAll, dbGet } from '../db/index.js';
import { repos } from '../db/repos.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import { onAutomationThreadTerminal } from './automation-runs.js';
import { relayToThreadStream, relayToUser } from './browser-events.js';
import * as messageQueueRepo from './message-queue-repository.js';
import * as projectRepo from './project-repository.js';
import * as startupCommandsRepo from './startup-commands-repository.js';

interface DataMessageContext {
  runnerId: string;
  /** DB-recorded owner of the runner (already validated by the ownership guard). */
  runnerUserId: string | null;
  /**
   * The user every user-scoped handler acts as: the runner's owner, NEVER a
   * payload-supplied userId. The ownership guard refuses every non-neutral
   * request from a runner without an owner, so this is only '' for the
   * user-neutral types (a missing data.userId used to widen list_projects to
   * every tenant — audit C4).
   */
  ownerId: string;
  data: any;
}

type DataMessageHandler = (ctx: DataMessageContext) => Promise<any>;

// Statuses that end a run. Only these are re-broadcast from the persistence
// path: 'waiting' must NOT be, because the client's status handler would apply
// it without the waitingReason/permissionRequest payload that only the live
// agent:status event carries (clobbering an on-screen permission prompt).
const TERMINAL_THREAD_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

/**
 * Mirror a persisted terminal-status change to the owner's browsers (and the
 * sharee stream room) as `thread:updated`.
 *
 * The live `agent:result`/`agent:status` events travel a lossy path — the
 * runner drops them while the tunnel is down, and the server's per-socket rate
 * limit sheds them during chunk storms — while this data-channel write is the
 * reliable signal that the run actually ended. Without this mirror, a lost
 * result event leaves every open tab stuck on "processing" until a manual
 * refresh, even though the DB already says the thread completed.
 */
function notifyTerminalStatusPersisted(
  runnerUserId: string | null,
  threadId: unknown,
  updates: unknown,
): void {
  const status = (updates as { status?: unknown } | null)?.status;
  if (!runnerUserId || typeof threadId !== 'string') return;
  if (typeof status !== 'string' || !TERMINAL_THREAD_STATUSES.has(status)) return;
  // A thread started by an automation completes its run here (durable signal).
  void onAutomationThreadTerminal(threadId, status).catch((error) =>
    log.error('Failed to complete automation run', {
      namespace: 'automation',
      threadId,
      error: (error as Error).message,
    }),
  );
  const event = { type: 'thread:updated', threadId, data: { status } };
  relayToUser(runnerUserId, event);
  relayToThreadStream(threadId, event);
}

async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  if (!userId) return false;
  const row = await dbGet(
    db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId))),
  );
  return !!row;
}

/**
 * The org a runner-originated create_project may file under: null when none
 * was requested, `false` when the runner's owner is not a member of it.
 */
async function resolveCreateProjectOrg(
  ownerId: string,
  rawOrgId: unknown,
): Promise<string | null | false> {
  if (typeof rawOrgId !== 'string' || !rawOrgId) return null;
  return (await isOrgMember(ownerId, rawOrgId)) ? rawOrgId : false;
}

/**
 * Resolve an agent template for a runner: builtins for anyone; custom rows
 * only when owned by the runner's user or shared — never another tenant's
 * private template (system prompt, MCP config).
 */
async function findAgentTemplateForRunner(ownerId: string, templateId: unknown): Promise<unknown> {
  const { BUILTIN_AGENT_TEMPLATES } = await import('@funny/shared');
  const builtin = BUILTIN_AGENT_TEMPLATES.find((t: { id: string }) => t.id === templateId);
  if (builtin) return builtin;
  if (!ownerId || typeof templateId !== 'string') return null;
  const row = await dbGet(
    db
      .select()
      .from(schema.agentTemplates)
      .where(
        and(
          eq(schema.agentTemplates.id, templateId),
          or(eq(schema.agentTemplates.userId, ownerId), eq(schema.agentTemplates.shared, true)),
        ),
      ),
  );
  return row ?? null;
}

// ── Watcher / job patch allow-lists ──────────────────────────────

/** Keep `patch[key]` when it passes `ok`; drop it otherwise. */
function copyIf<T>(
  out: Record<string, unknown>,
  patch: Record<string, unknown>,
  key: string,
  ok: (v: unknown) => v is T,
): void {
  if (Object.hasOwn(patch, key) && ok(patch[key])) out[key] = patch[key];
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Fields a runner may change on its own watcher — never owner, thread, key,
 * or caps. Values are type-checked; anything else is dropped.
 */
function pickWatcherPatch(raw: unknown): WatcherPatch {
  const patch = asRecord(raw);
  const out: Record<string, unknown> = {};
  copyIf(out, patch, 'nextWakeAt', isNum);
  copyIf(out, patch, 'lastDelayMs', isNum);
  copyIf(out, patch, 'wakeCount', isNum);
  copyIf(out, patch, 'status', isStr);
  copyIf(out, patch, 'updatedAt', isStr);
  return out as WatcherPatch;
}

/**
 * Fields a runner may change on its own job. `logPath`/`exitPath`/`command`/
 * `cwd` are fixed at insert (the victim-file-read primitive), and `userId`/
 * `threadId` are never re-assignable. `pid` stays patchable because the
 * ownership guard already restricts updates to the runner user's own jobs.
 */
function pickJobPatch(raw: unknown): JobPatch {
  const patch = asRecord(raw);
  const out: Record<string, unknown> = {};
  copyIf(out, patch, 'pid', isNumOrNull);
  copyIf(out, patch, 'status', isStr);
  copyIf(out, patch, 'exitCode', isNumOrNull);
  copyIf(out, patch, 'updatedAt', isStr);
  return out as JobPatch;
}

/**
 * Watcher/job ops that carry no entity are scoped to the runner's owner.
 * Without an owner (an empty id would mean "every user" to the list queries)
 * they never run — they return an empty list.
 */
const OWNER_SCOPED_LIST_FALLBACK = [] as const;

/** Dispatch table: one executor per `data:*` message type. */
const DATA_MESSAGE_HANDLERS: Readonly<Record<string, DataMessageHandler>> = {
  'data:insert_message': async ({ data }) => {
    const messageRepo = repos.messages();
    const messageId = await messageRepo.insertMessage(data.payload);
    return { type: 'data:insert_message_response', messageId };
  },
  'data:insert_tool_call': async ({ data }) => {
    const toolCallRepo = repos.toolCalls();
    const toolCallId = await toolCallRepo.insertToolCall(data.payload);
    return { type: 'data:insert_tool_call_response', toolCallId };
  },
  'data:update_thread': async ({ runnerUserId, data }) => {
    const threadRepo = repos.threads();
    await threadRepo.updateThread(data.payload.threadId, data.payload.updates);
    notifyTerminalStatusPersisted(runnerUserId, data.payload.threadId, data.payload.updates);
    return { type: 'data:update_thread_response', ok: true };
  },
  'data:create_pending_permission_request': async ({ data }) => {
    await repos.pendingPermissions().create(data.payload);
    return { type: 'data:ack', success: true };
  },
  'data:resolve_pending_permission_request': async ({ data }) => {
    const resolved = await repos
      .pendingPermissions()
      .resolve(data.payload.requestId, data.payload.decision);
    return { type: 'data:ack', success: resolved };
  },
  'data:expire_pending_permission_request': async ({ data }) => {
    await repos.pendingPermissions().expire(data.payload.requestId);
    return { type: 'data:ack', success: true };
  },
  'data:update_message': async ({ data }) => {
    const messageRepo = repos.messages();
    await messageRepo.updateMessage(data.payload.messageId, data.payload.content);
    return { type: 'data:ack', success: true };
  },
  'data:delete_messages_after': async ({ data }) => {
    const messageRepo = repos.messages();
    const deletedCount = await messageRepo.deleteMessagesAfter(
      data.payload.threadId,
      data.payload.anchorMessageId,
    );
    return { type: 'data:delete_messages_after_response', deletedCount };
  },
  'data:insert_comment': async ({ runnerUserId, data }) => {
    const inserted = await repos.comments().insertComment({
      ...data.payload,
      userId: runnerUserId,
    });
    return { type: 'data:insert_comment_response', commentId: inserted.id };
  },
  'data:update_tool_call_output': async ({ data }) => {
    const toolCallRepo = repos.toolCalls();
    await toolCallRepo.updateToolCallOutput(data.payload.toolCallId, data.payload.output);
    return { type: 'data:ack', success: true };
  },
  'data:get_thread': async ({ data }) => {
    const threadRepo = repos.threads();
    const thread = await threadRepo.getThread(data.threadId);
    return { type: 'data:get_thread_response', thread: thread ?? null };
  },
  'data:get_thread_by_external_request_id': async ({ data }) => {
    const threadRepo = repos.threads();
    const thread = await threadRepo.getThreadByExternalRequestId(data.externalRequestId);
    return {
      type: 'data:get_thread_by_external_request_id_response',
      thread: thread ?? null,
    };
  },
  'data:get_thread_by_session_id': async ({ data }) => {
    const threadRepo = repos.threads();
    const thread = await threadRepo.getThreadBySessionId(data.sessionId);
    return {
      type: 'data:get_thread_by_session_id_response',
      thread: thread ?? null,
    };
  },
  'data:get_thread_with_messages': async ({ data }) => {
    const messageRepo = repos.messages();
    const thread = await messageRepo.getThreadWithMessages(
      data.threadId,
      typeof data.messageLimit === 'number' ? data.messageLimit : undefined,
      {
        messageProgress:
          typeof data.messageProgress === 'number' ? data.messageProgress : undefined,
        messageAnchorId:
          typeof data.messageAnchorId === 'string' ? data.messageAnchorId : undefined,
      },
    );
    return {
      type: 'data:get_thread_with_messages_response',
      thread: thread ?? null,
    };
  },
  'data:get_thread_messages': async ({ data }) => {
    const messageRepo = repos.messages();
    const result = await messageRepo.getThreadMessages({
      threadId: data.threadId,
      cursor: typeof data.cursor === 'string' ? data.cursor : undefined,
      limit: typeof data.limit === 'number' ? data.limit : 50,
      direction: data.direction === 'after' ? 'after' : 'before',
    });
    return {
      type: 'data:get_thread_messages_response',
      messages: result.messages,
      hasMore: result.hasMore,
      hasMoreAfter: result.hasMoreAfter,
      total: result.total,
      windowStart: result.windowStart,
      leadingUserMessage: result.leadingUserMessage,
    };
  },
  'data:get_tool_call': async ({ data }) => {
    const toolCallRepo = repos.toolCalls();
    const toolCall = await toolCallRepo.getToolCall(data.toolCallId);
    return {
      type: 'data:get_tool_call_response',
      toolCall: toolCall ?? null,
    };
  },
  'data:search_threads': async ({ runnerUserId, data }) => {
    // Carries no entity id — scoped to the runner's own user (like the
    // watcher/job list ops), so no per-entity ownership check is needed.
    if (!runnerUserId) {
      return { type: 'data:search_threads_response', results: [] };
    }
    const { searchThreadMessages } = await import('./search-repository.js');
    const results = await searchThreadMessages({
      userId: runnerUserId,
      query: typeof data.query === 'string' ? data.query : undefined,
      author: typeof data.author === 'string' ? data.author : undefined,
      since: typeof data.since === 'string' ? data.since : undefined,
      until: typeof data.until === 'string' ? data.until : undefined,
      projectId: typeof data.projectId === 'string' ? data.projectId : undefined,
      limit: typeof data.limit === 'number' ? data.limit : undefined,
      caseSensitive: typeof data.caseSensitive === 'boolean' ? data.caseSensitive : undefined,
    });
    return { type: 'data:search_threads_response', results };
  },
  'data:find_tool_call': async ({ data }) => {
    const toolCallRepo = repos.toolCalls();
    const tc = await toolCallRepo.findToolCall(
      data.payload.messageId,
      data.payload.name,
      data.payload.input,
    );
    return { type: 'data:find_tool_call_response', toolCall: tc ?? null };
  },
  'data:find_last_unanswered_interactive_tool_call': async ({ data }) => {
    const toolCallRepo = repos.toolCalls();
    const tc = await toolCallRepo.findLastUnansweredInteractiveToolCall(data.threadId);
    return {
      type: 'data:find_last_unanswered_interactive_tool_call_response',
      toolCall: tc ?? null,
    };
  },
  'data:get_project': async ({ data }) => {
    const project = await projectRepo.getProject(data.projectId);
    return { type: 'data:get_project_response', project: project ?? null };
  },
  'data:get_startup_command': async ({ data }) => {
    const command = await startupCommandsRepo.getCommand(data.cmdId, data.projectId);
    return {
      type: 'data:get_startup_command_response',
      command: command ?? null,
    };
  },
  'data:get_agent_template': async ({ ownerId, data }) => ({
    type: 'data:get_agent_template_response',
    template: await findAgentTemplateForRunner(ownerId, data.templateId),
  }),
  'data:list_projects': async ({ ownerId }) => {
    // Collaborator model: the runner needs the user's owned projects AND
    // the projects they were added to directly — the latter carry the
    // member's own `localPath`, which path-scope uses to authorize file/git
    // access on the member's machine.
    const owned = await projectRepo.listProjects(ownerId);
    const ownedIds = new Set(owned.map((p) => p.id));
    const shared = (await projectRepo.listMemberProjects(ownerId)).filter(
      (p) => p.userId !== ownerId && !ownedIds.has(p.id),
    );
    return {
      type: 'data:list_projects_response',
      projects: [...owned, ...shared],
    };
  },
  'data:list_project_threads': async ({ runnerUserId, data }) => {
    // The ownership guard (data-ownership.ts) rejects this request when the runner has
    // no user, but keep the narrowing local to this data-plane query.
    if (!runnerUserId) {
      return { type: 'data:ack', success: false, error: 'Forbidden' };
    }
    const threads = await dbAll(
      db
        .select({
          id: schema.threads.id,
          userId: schema.threads.userId,
          projectId: schema.threads.projectId,
          mode: schema.threads.mode,
          worktreePath: schema.threads.worktreePath,
          branch: schema.threads.branch,
          baseBranch: schema.threads.baseBranch,
          mergedAt: schema.threads.mergedAt,
          status: schema.threads.status,
        })
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.projectId, data.projectId),
            eq(schema.threads.userId, runnerUserId),
            eq(schema.threads.archived, 0),
            eq(schema.threads.isScratch, 0),
          ),
        ),
    );
    return { type: 'data:list_project_threads_response', threads };
  },
  'data:resolve_project_path': async ({ ownerId, data }) => {
    const result = await projectRepo.resolveProjectPath(data.projectId, ownerId);
    if (result.isOk()) {
      return {
        type: 'data:resolve_project_path_response',
        ok: true,
        path: result.value,
      };
    } else {
      return {
        type: 'data:resolve_project_path_response',
        ok: false,
        error: result.error.message,
      };
    }
  },
  'data:create_project': async ({ runnerId, ownerId, data }) => {
    // Skip filesystem checks — the runner already validated the path
    // (clone succeeded, or the runner ran HI-3 containment against its own
    // $HOME before proxying creation here).
    // A runner may only file a project under an org its owner belongs to.
    const orgId = await resolveCreateProjectOrg(ownerId, data.orgId);
    if (orgId === false) {
      return {
        type: 'data:create_project_response',
        error: 'Not a member of the requested organization',
        errorType: 'FORBIDDEN',
      };
    }
    const cpResult = await projectRepo.createProject(data.name, data.path, ownerId, orgId, true);
    if (cpResult.isOk()) {
      if (orgId) {
        await projectRepo.addProjectToOrg(cpResult.value.id, orgId);
      }
      // Assign the project to the creating runner here, on the same
      // round-trip that persisted it. The runner also fires a separate
      // `runner:assign_project` message, but that path can be lost (its
      // ack is dropped under the data-channel request/response shim),
      // which orphans the project — project-scoped routing (terminal/PTY
      // via findRunnerForProject) then fails until the next runner
      // restart. assignProject is idempotent (onConflictDoUpdate), so the
      // redundant write is harmless.
      try {
        const rm = await import('./runner-manager.js');
        await rm.assignProject(runnerId, {
          projectId: cpResult.value.id,
          localPath: cpResult.value.path,
        });
      } catch (e) {
        log.warn('Failed to auto-assign created project to runner', {
          namespace: 'data-handler',
          runnerId,
          projectId: cpResult.value.id,
          error: (e as Error).message,
        });
      }
      return {
        type: 'data:create_project_response',
        project: cpResult.value,
      };
    } else {
      return {
        type: 'data:create_project_response',
        error: cpResult.error.message,
        errorType: cpResult.error.type,
      };
    }
  },
  'data:create_thread': async ({ ownerId, data }) => {
    const tRepo = repos.threads();
    // The thread is always owned by the runner's user (the ownership guard
    // already refuses a mismatching payload.userId).
    await tRepo.createThread({ ...data.payload, userId: ownerId });
    return { type: 'data:ack', success: true };
  },
  'data:delete_thread': async ({ data }) => {
    const tRepo = repos.threads();
    await tRepo.deleteThread(data.threadId);
    return { type: 'data:ack', success: true };
  },
  'data:enqueue_message': async ({ data }) => {
    const queued = await messageQueueRepo.enqueue(data.threadId, data.payload);
    return { type: 'data:enqueue_message_response', queued };
  },
  'data:dequeue_message': async ({ data }) => {
    const dequeued = await messageQueueRepo.dequeue(data.threadId);
    return { type: 'data:dequeue_message_response', dequeued };
  },
  'data:peek_message': async ({ data }) => {
    const peeked = await messageQueueRepo.peek(data.threadId);
    return { type: 'data:peek_message_response', peeked };
  },
  'data:queue_count': async ({ data }) => {
    const count = await messageQueueRepo.queueCount(data.threadId);
    return { type: 'data:queue_count_response', count };
  },
  'data:list_queue': async ({ data }) => {
    const items = await messageQueueRepo.listQueue(data.threadId);
    return { type: 'data:list_queue_response', items };
  },
  'data:cancel_queued_message': async ({ data }) => {
    // The ownership guard already verified message → thread → runnerUserId.
    // Resolve threadId here so cancel can scope by (messageId, threadId).
    const q = (await dbGet(
      db
        .select({ threadId: schema.messageQueue.threadId })
        .from(schema.messageQueue)
        .where(eq(schema.messageQueue.id, data.messageId)),
    )) as { threadId: string } | undefined;
    if (!q)
      return {
        type: 'data:cancel_queued_message_response',
        success: false,
      };
    const success = await messageQueueRepo.cancel(data.messageId, q.threadId);
    return { type: 'data:cancel_queued_message_response', success };
  },
  'data:update_queued_message': async ({ data }) => {
    const q = (await dbGet(
      db
        .select({ threadId: schema.messageQueue.threadId })
        .from(schema.messageQueue)
        .where(eq(schema.messageQueue.id, data.messageId)),
    )) as { threadId: string } | undefined;
    if (!q) return { type: 'data:update_queued_message_response', updated: null };
    const updated = await messageQueueRepo.update(data.messageId, q.threadId, data.content);
    return { type: 'data:update_queued_message_response', updated };
  },
  'data:save_thread_event': async ({ data }) => {
    const { saveThreadEvent } = await import('./thread-event-repository.js');
    await saveThreadEvent(data.payload.threadId, data.payload.eventType, data.payload.data);
    return { type: 'data:ack', success: true };
  },
  'data:get_profile': async ({ ownerId }) => {
    const { getProfile } = await import('./profile-service.js');
    const profile = await getProfile(ownerId);
    return { type: 'data:get_profile_response', profile: profile ?? null };
  },
  'data:get_provider_key': async ({ ownerId, data }) => {
    const { getProviderKey } = await import('./profile-service.js');
    const key = await getProviderKey(ownerId, data.provider);
    return { type: 'data:get_provider_key_response', key: key ?? null };
  },
  'data:get_github_token': async ({ runnerId, ownerId, data }) => {
    // Project override first (project-runner-binding), then the user's PAT.
    const { resolveProjectGithubToken } = await import('./runner-scope.js');
    const { getProviderKey } = await import('./profile-service.js');
    const token =
      (await resolveProjectGithubToken(
        runnerId,
        typeof data.projectId === 'string' ? data.projectId : null,
      )) ?? (await getProviderKey(ownerId, 'github'));
    return { type: 'data:get_github_token_response', token: token ?? null };
  },
  'data:get_minimax_api_key': async ({ ownerId }) => {
    const { getProviderKey } = await import('./profile-service.js');
    const key = await getProviderKey(ownerId, 'minimax');
    return { type: 'data:get_minimax_api_key_response', key: key ?? null };
  },
  'data:update_profile': async ({ ownerId, data }) => {
    const { upsertProfile } = await import('./profile-service.js');
    const updatedProfile = await upsertProfile(ownerId, data.payload);
    return {
      type: 'data:update_profile_response',
      profile: updatedProfile,
    };
  },
  'data:resolve_agent_execution_profile': async ({ ownerId, data }) => {
    const { resolveEffectiveProfile } = await import('./agent-execution-profile-repository.js');
    const resolved = await resolveEffectiveProfile(data.projectId, ownerId);
    return {
      type: 'data:resolve_agent_execution_profile_response',
      ...resolved,
    };
  },
  'data:get_builtin_providers': async ({ runnerUserId }) => {
    // Owner-scoped: the runner asks for its owning user's stored selection.
    // The ownership guard already required a non-null runnerUserId.
    if (!runnerUserId) {
      return { type: 'data:get_builtin_providers_response', active: null };
    }
    const { getBuiltinProviderSettings } = await import('./profile-service.js');
    const active = await getBuiltinProviderSettings(runnerUserId);
    return { type: 'data:get_builtin_providers_response', active };
  },
  'data:set_builtin_providers': async ({ runnerUserId, data }) => {
    if (!runnerUserId) {
      return {
        type: 'data:ack',
        success: false,
        error: 'runner has no owning user',
      };
    }
    const { setBuiltinProviderSettings } = await import('./profile-service.js');
    const active = Array.isArray(data.active)
      ? data.active.filter((x: unknown): x is string => typeof x === 'string')
      : null;
    await setBuiltinProviderSettings(runnerUserId, active);
    return { type: 'data:ack', success: true };
  },
  'data:mark_and_list_stale_threads': async ({ runnerId }) => {
    const threadRepo = repos.threads();
    const staleThreads = await threadRepo.markAndListStaleThreads(runnerId);
    return {
      type: 'data:mark_and_list_stale_threads_response',
      threads: staleThreads,
    };
  },

  // ── Agent watchers (deferred-wake "snooze") ──────────────────
  // Every op acts as the runner's owner: inserts force row.userId, updates go
  // through typed patch allow-lists, and lists are owner-scoped (never "all").
  // By-id and by-thread ops were already owner-checked by data-ownership.ts.
  'data:watcher_insert': async ({ ownerId, data }) => {
    await repos.watchers().insert({ ...data.payload.row, userId: ownerId });
    return { type: 'data:watcher_insert_response', ok: true };
  },
  'data:watcher_get': async ({ data }) => {
    const watcher = await repos.watchers().getById(data.payload.id);
    return { type: 'data:watcher_get_response', watcher: watcher ?? null };
  },
  'data:watcher_get_live_by_thread_key': async ({ data }) => {
    const watcher = await repos
      .watchers()
      .getLiveByThreadKey(data.payload.threadId, data.payload.key);
    return {
      type: 'data:watcher_get_live_by_thread_key_response',
      watcher: watcher ?? null,
    };
  },
  'data:watcher_list_pending': async ({ ownerId }) => ({
    type: 'data:watcher_list_pending_response',
    watchers: ownerId ? await repos.watchers().listPending(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_list_due': async ({ ownerId, data }) => ({
    type: 'data:watcher_list_due_response',
    watchers: ownerId
      ? await repos.watchers().listDue(data.payload.now, ownerId)
      : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_list_by_user': async ({ ownerId }) => ({
    type: 'data:watcher_list_by_user_response',
    watchers: ownerId ? await repos.watchers().listByUser(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:watcher_update': async ({ data }) => {
    await repos.watchers().update(data.payload.id, pickWatcherPatch(data.payload.patch));
    return { type: 'data:watcher_update_response', ok: true };
  },
  'data:watcher_delete_by_thread': async ({ data }) => {
    await repos.watchers().deleteByThread(data.payload.threadId);
    return { type: 'data:watcher_delete_by_thread_response', ok: true };
  },

  // ── Agent jobs ───────────────────────────────────────────────
  'data:job_insert': async ({ ownerId, data }) => {
    await repos.jobs().insert({ ...data.payload.row, userId: ownerId });
    return { type: 'data:job_insert_response', ok: true };
  },
  'data:job_get': async ({ data }) => {
    const job = await repos.jobs().getById(data.payload.id);
    return { type: 'data:job_get_response', job: job ?? null };
  },
  'data:job_list_running': async ({ ownerId }) => ({
    type: 'data:job_list_running_response',
    jobs: ownerId ? await repos.jobs().listRunning(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:job_list_by_user': async ({ ownerId }) => ({
    type: 'data:job_list_by_user_response',
    jobs: ownerId ? await repos.jobs().listByUser(ownerId) : OWNER_SCOPED_LIST_FALLBACK,
  }),
  'data:job_update': async ({ data }) => {
    await repos.jobs().update(data.payload.id, pickJobPatch(data.payload.patch));
    return { type: 'data:job_update_response', ok: true };
  },
  'data:job_delete_by_thread': async ({ data }) => {
    await repos.jobs().deleteByThread(data.payload.threadId);
    return { type: 'data:job_delete_by_thread_response', ok: true };
  },

  // ── Durable permission rules ────────────────────────────────
  'data:create_permission_rule': async ({ runnerUserId, data }) => {
    const { createRule } = await import('./permission-rules-service.js');
    const result = await createRule({
      ...data.payload,
      userId: runnerUserId!,
    });
    if (result.isErr()) throw result.error;
    return {
      type: 'data:create_permission_rule_response',
      rule: result.value,
    };
  },
  'data:find_permission_rule': async ({ runnerUserId, data }) => {
    const { findMatch } = await import('./permission-rules-service.js');
    const result = await findMatch({
      ...data.payload,
      userId: runnerUserId!,
    });
    if (result.isErr()) throw result.error;
    return {
      type: 'data:find_permission_rule_response',
      rule: result.value,
    };
  },
  'data:list_permission_rules': async ({ runnerUserId, data }) => {
    const { listRules } = await import('./permission-rules-service.js');
    const result = await listRules({
      ...data.payload,
      userId: runnerUserId!,
    });
    if (result.isErr()) throw result.error;
    return {
      type: 'data:list_permission_rules_response',
      rules: result.value,
    };
  },
};

/**
 * Execute an already-authorized data message. Unknown types are logged and
 * answered with `undefined`.
 */
export async function executeDataMessage(
  runnerId: string,
  runnerUserId: string | null,
  data: any,
): Promise<any> {
  const type = data.type;
  const handler = Object.hasOwn(DATA_MESSAGE_HANDLERS, type)
    ? DATA_MESSAGE_HANDLERS[type]
    : undefined;
  if (!handler) {
    log.warn('Unknown data message type from runner', {
      namespace: 'data-handler',
      runnerId,
      type: data.type,
    });
    return undefined;
  }
  return handler({ runnerId, runnerUserId, ownerId: runnerUserId ?? '', data });
}
