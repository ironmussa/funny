/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: policy
 * @domain layer: application
 *
 * Project scope for the runner→server data channel (project-runner-binding).
 *
 * `assertDataOwnership` (data-handler.ts) answers "does this runner's USER own
 * the entity?". This module answers the second question: "may THIS RUNNER touch
 * the project the entity belongs to?" — a dedicated runner must never read or
 * write another project's threads/messages/queues, even when both belong to the
 * same user.
 *
 * Every `data:*` type MUST have an entry in `DATA_SCOPE_RULES`; unknown types
 * are refused (fail closed). A test enumerates the handler's `case` labels so a
 * new data type cannot ship without a rule.
 */

import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { canRunnerAccessProject, canRunnerServeProjectless } from './runner-scope.js';

/**
 * - `refs`: the request references threads/projects/messages/…; each one must
 *   resolve to a project the runner may access (projectless → general only).
 * - `projectless`: creates projectless state (local project, scratch) — general
 *   runners only.
 * - `user`: user-level settings/credentials every runner of the user needs to
 *   behave identically (providers, profile, permission rules…). Still checked
 *   for any explicit project/thread reference.
 * - `list`: returns a collection; allowed, but the response is filtered down to
 *   accessible projects by `filterDataResponse`.
 */
export type DataScopeRule = 'refs' | 'projectless' | 'user' | 'list';

export const DATA_SCOPE_RULES: Record<string, DataScopeRule> = {
  'data:insert_message': 'refs',
  'data:insert_tool_call': 'refs',
  'data:update_thread': 'refs',
  'data:create_pending_permission_request': 'refs',
  'data:resolve_pending_permission_request': 'refs',
  'data:expire_pending_permission_request': 'refs',
  'data:update_message': 'refs',
  'data:delete_messages_after': 'refs',
  'data:insert_comment': 'refs',
  'data:update_tool_call_output': 'refs',
  'data:get_thread': 'refs',
  'data:get_thread_by_external_request_id': 'refs',
  'data:get_thread_by_session_id': 'refs',
  'data:get_thread_with_messages': 'refs',
  'data:get_thread_messages': 'refs',
  'data:get_tool_call': 'refs',
  'data:find_tool_call': 'refs',
  'data:find_last_unanswered_interactive_tool_call': 'refs',
  'data:get_project': 'refs',
  'data:get_startup_command': 'refs',
  'data:list_project_threads': 'refs',
  'data:resolve_project_path': 'refs',
  'data:create_thread': 'refs',
  'data:delete_thread': 'refs',
  'data:enqueue_message': 'refs',
  'data:dequeue_message': 'refs',
  'data:peek_message': 'refs',
  'data:queue_count': 'refs',
  'data:list_queue': 'refs',
  'data:cancel_queued_message': 'refs',
  'data:update_queued_message': 'refs',
  'data:save_thread_event': 'refs',
  'data:resolve_agent_execution_profile': 'refs',
  'data:watcher_insert': 'refs',
  'data:watcher_get': 'refs',
  'data:watcher_get_live_by_thread_key': 'refs',
  'data:watcher_update': 'refs',
  'data:watcher_delete_by_thread': 'refs',
  'data:job_insert': 'refs',
  'data:job_get': 'refs',
  'data:job_update': 'refs',
  'data:job_delete_by_thread': 'refs',

  'data:create_project': 'projectless',

  'data:get_agent_template': 'user',
  'data:get_profile': 'user',
  'data:get_provider_key': 'user',
  'data:get_github_token': 'user',
  'data:get_minimax_api_key': 'user',
  'data:update_profile': 'user',
  'data:get_builtin_providers': 'user',
  'data:set_builtin_providers': 'user',
  'data:mark_and_list_stale_threads': 'user',
  'data:create_permission_rule': 'user',
  'data:find_permission_rule': 'user',
  'data:list_permission_rules': 'user',

  'data:list_projects': 'list',
  'data:search_threads': 'list',
  'data:watcher_list_pending': 'list',
  'data:watcher_list_due': 'list',
  'data:watcher_list_by_user': 'list',
  'data:job_list_running': 'list',
  'data:job_list_by_user': 'list',
};

// thread → owner/project never changes after creation, so it is safe to memoize.
const THREAD_CACHE_MAX = 5_000;
const threadCache = new Map<string, { projectId: string | null; userId: string }>();

async function threadInfo(
  threadId: string,
): Promise<{ projectId: string | null; userId: string } | undefined> {
  const cached = threadCache.get(threadId);
  if (cached) return cached;
  const [row] = await db
    .select({ projectId: schema.threads.projectId, userId: schema.threads.userId })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  if (!row) return undefined;
  if (threadCache.size >= THREAD_CACHE_MAX) threadCache.clear();
  const info = { projectId: row.projectId ?? null, userId: row.userId };
  threadCache.set(threadId, info);
  return info;
}

/** `undefined` = thread not found; `null` = projectless (scratch). */
async function projectOfThread(threadId: string): Promise<string | null | undefined> {
  const info = await threadInfo(threadId);
  return info === undefined ? undefined : info.projectId;
}

/**
 * May `runnerId` (owned by `runnerUserId`) emit events / act on `threadId`?
 * Owner must match AND the thread's project must be in the runner's scope.
 */
export async function canRunnerActOnThread(
  runnerId: string,
  runnerUserId: string | null | undefined,
  threadId: string,
): Promise<boolean> {
  if (!runnerUserId) return false;
  const info = await threadInfo(threadId);
  if (!info || info.userId !== runnerUserId) return false;
  return info.projectId === null
    ? canRunnerServeProjectless(runnerId)
    : canRunnerAccessProject(runnerId, info.projectId);
}

async function firstThreadId(
  query: Promise<Array<{ threadId: string | null }>>,
): Promise<string | undefined> {
  const [row] = await query;
  return row?.threadId ?? undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Thread ids referenced (directly or indirectly) by a data request. */
async function referencedThreadIds(data: any): Promise<string[]> {
  const payload = data?.payload ?? {};
  const ids = [str(data?.threadId), str(payload.threadId), str(payload.row?.threadId)].filter(
    (x): x is string => !!x,
  );

  const type = data?.type;
  if (type === 'data:get_thread_by_external_request_id' && str(data.externalRequestId)) {
    const [row] = await db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.externalRequestId, data.externalRequestId));
    if (row) ids.push(row.id);
  }
  if (type === 'data:get_thread_by_session_id' && str(data.sessionId)) {
    const [row] = await db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.sessionId, data.sessionId));
    if (row) ids.push(row.id);
  }
  const messageId =
    type === 'data:update_message' ||
    type === 'data:find_tool_call' ||
    type === 'data:insert_tool_call'
      ? str(payload.messageId)
      : undefined;
  if (messageId) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId)),
    );
    if (t) ids.push(t);
  }
  const toolCallId =
    type === 'data:get_tool_call'
      ? str(data.toolCallId)
      : type === 'data:update_tool_call_output'
        ? str(payload.toolCallId)
        : undefined;
  if (toolCallId) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.messages.threadId })
        .from(schema.toolCalls)
        .innerJoin(schema.messages, eq(schema.messages.id, schema.toolCalls.messageId))
        .where(eq(schema.toolCalls.id, toolCallId)),
    );
    if (t) ids.push(t);
  }
  if (
    (type === 'data:cancel_queued_message' || type === 'data:update_queued_message') &&
    str(data.messageId)
  ) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.messageQueue.threadId })
        .from(schema.messageQueue)
        .where(eq(schema.messageQueue.id, data.messageId)),
    );
    if (t) ids.push(t);
  }
  if ((type === 'data:watcher_update' || type === 'data:watcher_get') && str(payload.id)) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.watchers.threadId })
        .from(schema.watchers)
        .where(eq(schema.watchers.id, payload.id)),
    );
    if (t) ids.push(t);
  }
  if ((type === 'data:job_update' || type === 'data:job_get') && str(payload.id)) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.jobs.threadId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, payload.id)),
    );
    if (t) ids.push(t);
  }
  if (
    (type === 'data:resolve_pending_permission_request' ||
      type === 'data:expire_pending_permission_request') &&
    str(payload.requestId)
  ) {
    const t = await firstThreadId(
      db
        .select({ threadId: schema.pendingPermissionRequests.threadId })
        .from(schema.pendingPermissionRequests)
        .where(eq(schema.pendingPermissionRequests.requestId, payload.requestId)),
    );
    if (t) ids.push(t);
  }
  return [...new Set(ids)];
}

export type DataScopeDecision = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `runnerId` may perform `data` with respect to project scope.
 * Run AFTER the user-ownership check.
 */
export async function assertRunnerDataScope(
  runnerId: string,
  data: any,
): Promise<DataScopeDecision> {
  const type = data?.type;
  const rule = DATA_SCOPE_RULES[type];
  if (!rule) return { ok: false, reason: `no scope rule for ${String(type)}` };

  const isScratchCreate =
    type === 'data:create_thread' && !str(data?.payload?.projectId) && !str(data?.projectId);
  if (rule === 'projectless' || isScratchCreate) {
    return (await canRunnerServeProjectless(runnerId))
      ? { ok: true }
      : {
          ok: false,
          reason: `${type} is projectless work (general runners only)`,
        };
  }

  const payload = data?.payload ?? {};
  const projectIds = new Set(
    [str(data?.projectId), str(payload.projectId)].filter((x): x is string => !!x),
  );
  let projectless = false;
  for (const threadId of await referencedThreadIds(data)) {
    const projectId = await projectOfThread(threadId);
    if (projectId === undefined) continue; // not-found is handled by the ownership check
    if (projectId === null) projectless = true;
    else projectIds.add(projectId);
  }

  for (const projectId of projectIds) {
    if (!(await canRunnerAccessProject(runnerId, projectId))) {
      return { ok: false, reason: `project ${projectId} outside runner scope` };
    }
  }
  if (projectless && !(await canRunnerServeProjectless(runnerId))) {
    return { ok: false, reason: 'scratch thread outside runner scope' };
  }
  return { ok: true };
}

/** Drop items of other projects from collection responses (`list` rule). */
export async function filterDataResponse(runnerId: string, type: string, response: any) {
  if (DATA_SCOPE_RULES[type] !== 'list' || !response) return response;

  const projectAllowed = new Map<string, boolean>();
  const allowProject = async (projectId: string | null | undefined) => {
    if (projectId === undefined) return false;
    if (projectId === null) return canRunnerServeProjectless(runnerId);
    if (!projectAllowed.has(projectId)) {
      projectAllowed.set(projectId, await canRunnerAccessProject(runnerId, projectId));
    }
    return projectAllowed.get(projectId)!;
  };
  const allowThread = async (threadId: unknown) =>
    typeof threadId === 'string' && allowProject(await projectOfThread(threadId));

  const filterBy = async <T>(items: T[] | undefined, keep: (item: T) => Promise<boolean>) => {
    if (!Array.isArray(items)) return items;
    const out: T[] = [];
    for (const item of items) if (await keep(item)) out.push(item);
    return out;
  };

  switch (type) {
    case 'data:list_projects':
      return {
        ...response,
        projects: await filterBy(response.projects, (p: any) => allowProject(p?.id)),
      };
    case 'data:search_threads':
      return {
        ...response,
        results: await filterBy(response.results, (r: any) => allowThread(r?.threadId)),
      };
    case 'data:watcher_list_pending':
    case 'data:watcher_list_due':
    case 'data:watcher_list_by_user':
      return {
        ...response,
        watchers: await filterBy(response.watchers, (w: any) => allowThread(w?.threadId)),
      };
    case 'data:job_list_running':
    case 'data:job_list_by_user':
      return {
        ...response,
        jobs: await filterBy(response.jobs, (j: any) => allowThread(j?.threadId)),
      };
    default:
      return response;
  }
}

/** Test helper. */
export function __resetDataScopeCache() {
  threadCache.clear();
}
