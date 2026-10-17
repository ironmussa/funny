/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: policy
 * @domain layer: application
 *
 * Tenant-ownership checks for runner → server data messages.
 *
 * This is the tenant-isolation boundary for the data plane: without it, any
 * compromised or misconfigured runner can read another user's GitHub token,
 * delete someone else's thread, etc. (see SECURITY_AUDIT C3).
 *
 * The guard is an ordered pipeline of steps. Each step returns a denial (stop)
 * or `null` (continue). The order is part of the contract: it decides which
 * reason is reported when several checks would fail.
 */

import { and, eq } from 'drizzle-orm';

import { db, dbGet } from '../db/index.js';
import * as schema from '../db/schema.js';
import * as projectRepo from './project-repository.js';

type Denial = { ok: false; reason: string };
type OwnershipResult = { ok: true } | Denial;

interface OwnershipContext {
  /** DB-recorded owner of the runner sending the message. */
  userId: string;
  data: any;
  payload: any;
}

type OwnershipStep = (ctx: OwnershipContext) => Promise<Denial | null> | Denial | null;

type UserRow = { userId: string };
type ThreadRefRow = { threadId: string };

const OK: OwnershipResult = { ok: true };
const deny = (reason: string): Denial => ({ ok: false, reason });

/** `value` when it is a non-empty string, otherwise undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

// ── Row lookups ─────────────────────────────────────────────────

async function findThread(threadId: string): Promise<UserRow | undefined> {
  return (await dbGet(
    db
      .select({ userId: schema.threads.userId })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId)),
  )) as UserRow | undefined;
}

async function findMessage(messageId: string): Promise<ThreadRefRow | undefined> {
  return (await dbGet(
    db
      .select({ threadId: schema.messages.threadId })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId)),
  )) as ThreadRefRow | undefined;
}

const isOwnedBy = (row: UserRow | undefined, userId: string): boolean =>
  !!row && row.userId === userId;

// ── Generic steps (apply to every non-neutral type) ─────────────

/** Explicit userId on the request (or on create_thread's payload). */
function checkExplicitUserId({ userId, data, payload }: OwnershipContext): Denial | null {
  const candidate =
    nonEmptyString(data?.userId) ??
    (data?.type === 'data:create_thread' && typeof payload?.userId === 'string'
      ? payload.userId
      : undefined);
  return candidate && candidate !== userId
    ? deny(`userId ${candidate} !== runner ${userId}`)
    : null;
}

async function checkThread({ userId, data, payload }: OwnershipContext): Promise<Denial | null> {
  const threadId = nonEmptyString(data?.threadId) ?? nonEmptyString(payload?.threadId);
  if (!threadId) return null;
  const row = await findThread(threadId);
  if (!row) return deny(`thread ${threadId} not found`);
  return row.userId !== userId ? deny(`thread ${threadId} owned by ${row.userId}`) : null;
}

async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const member = await dbGet(
    db
      .select({ userId: schema.projectMembers.userId })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      ),
  );
  return !!member;
}

async function checkProject({ userId, data, payload }: OwnershipContext): Promise<Denial | null> {
  const projectId = nonEmptyString(data?.projectId) ?? nonEmptyString(payload?.projectId);
  if (!projectId) return null;
  const p = await projectRepo.getProject(projectId);
  if (!p) return deny(`project ${projectId} not found`);
  if (p.userId === userId) return null;
  // Allow if the runner's user is a member (per project_members).
  return (await isProjectMember(projectId, userId))
    ? null
    : deny(`project ${projectId} owned by ${p.userId}`);
}

// ── Type-specific steps ─────────────────────────────────────────

async function checkThreadByExternalRequestId({
  userId,
  data,
}: OwnershipContext): Promise<Denial | null> {
  if (typeof data?.externalRequestId !== 'string') return null;
  const row = (await dbGet(
    db
      .select({ userId: schema.threads.userId })
      .from(schema.threads)
      .where(eq(schema.threads.externalRequestId, data.externalRequestId)),
  )) as UserRow | undefined;
  return row && row.userId !== userId
    ? deny(`external request ${data.externalRequestId} owned by ${row.userId}`)
    : null;
}

async function checkThreadBySessionId({ userId, data }: OwnershipContext): Promise<Denial | null> {
  if (typeof data?.sessionId !== 'string') return null;
  const row = (await dbGet(
    db
      .select({ userId: schema.threads.userId })
      .from(schema.threads)
      .where(eq(schema.threads.sessionId, data.sessionId)),
  )) as UserRow | undefined;
  return row && row.userId !== userId
    ? deny(`session ${data.sessionId} owned by ${row.userId}`)
    : null;
}

/** Tool-call parent message (message → thread → user); a missing message passes. */
async function checkToolCallParentMessage({
  userId,
  payload,
}: OwnershipContext): Promise<Denial | null> {
  const messageId = nonEmptyString(payload?.messageId);
  if (!messageId) return null;
  const m = await findMessage(messageId);
  if (!m) return null;
  return isOwnedBy(await findThread(m.threadId), userId)
    ? null
    : deny(`message ${messageId} cross-tenant`);
}

/** update_message (message → thread → user); a missing message is refused. */
async function checkUpdateMessage({ userId, payload }: OwnershipContext): Promise<Denial | null> {
  if (typeof payload?.messageId !== 'string') return null;
  const messageId: string = payload.messageId;
  const m = await findMessage(messageId);
  if (!m) return deny(`message ${messageId} not found`);
  return isOwnedBy(await findThread(m.threadId), userId)
    ? null
    : deny(`message ${messageId} cross-tenant`);
}

/** Tool call ownership (toolCall → message → thread → user). */
async function checkToolCallId(
  toolCallId: string | undefined,
  userId: string,
): Promise<Denial | null> {
  if (!toolCallId) return null;
  const tc = (await dbGet(
    db
      .select({ messageId: schema.toolCalls.messageId })
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.id, toolCallId)),
  )) as { messageId: string } | undefined;
  if (!tc) return deny(`tool call ${toolCallId} not found`);
  const m = await findMessage(tc.messageId);
  if (!m) return deny(`tool call ${toolCallId} orphaned`);
  return isOwnedBy(await findThread(m.threadId), userId)
    ? null
    : deny(`tool call ${toolCallId} cross-tenant`);
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Queued message ownership (queue row → thread → user). */
async function checkQueuedMessage({ userId, data }: OwnershipContext): Promise<Denial | null> {
  if (typeof data?.messageId !== 'string') return null;
  const messageId: string = data.messageId;
  const q = (await dbGet(
    db
      .select({ threadId: schema.messageQueue.threadId })
      .from(schema.messageQueue)
      .where(eq(schema.messageQueue.id, messageId)),
  )) as ThreadRefRow | undefined;
  if (!q) return deny(`queued message ${messageId} not found`);
  return isOwnedBy(await findThread(q.threadId), userId)
    ? null
    : deny(`queued message ${messageId} cross-tenant`);
}

/**
 * Watcher / job ownership (row.user_id). Mutations / reads that reference a
 * watcher or job by id must belong to the runner's user. Inserts and
 * get_live_by_thread_key carry a payload.threadId and are covered by the
 * thread-ownership step; list ops carry no entity and are scoped to the
 * runner's user in the handler.
 */
function checkUserOwnedRow(
  kind: string,
  table: typeof schema.watchers | typeof schema.jobs,
): OwnershipStep {
  return async ({ userId, payload }) => {
    if (typeof payload?.id !== 'string') return null;
    const id: string = payload.id;
    const row = (await dbGet(
      db.select({ userId: table.userId }).from(table).where(eq(table.id, id)),
    )) as UserRow | undefined;
    if (!row) return deny(`${kind} ${id} not found`);
    return row.userId !== userId ? deny(`${kind} ${id} cross-tenant`) : null;
  };
}

async function assertPendingPermissionOwnership(
  runnerUserId: string,
  requestId: string,
): Promise<OwnershipResult> {
  const permission = (await dbGet(
    db
      .select({ threadId: schema.pendingPermissionRequests.threadId })
      .from(schema.pendingPermissionRequests)
      .where(eq(schema.pendingPermissionRequests.requestId, requestId)),
  )) as ThreadRefRow | undefined;
  if (!permission) return deny('permission request not found');
  const thread = await findThread(permission.threadId);
  return thread?.userId === runnerUserId ? OK : deny('permission request cross-tenant');
}

/**
 * Permission mutations identify the durable request rather than its thread.
 * Resolve that indirection before allowing the runner to change its state.
 */
async function checkPendingPermission({
  userId,
  payload,
}: OwnershipContext): Promise<Denial | null> {
  if (typeof payload?.requestId !== 'string') return null;
  const result = await assertPendingPermissionOwnership(userId, payload.requestId);
  return result.ok ? null : result;
}

/** Type-specific steps that run between the thread and project steps. */
const PRE_PROJECT_TYPE_CHECKS = new Map<string, OwnershipStep>([
  ['data:get_thread_by_external_request_id', checkThreadByExternalRequestId],
  ['data:get_thread_by_session_id', checkThreadBySessionId],
]);

const checkWatcher = checkUserOwnedRow('watcher', schema.watchers);
const checkJob = checkUserOwnedRow('job', schema.jobs);

/** Type-specific steps that run after the project step. */
const POST_PROJECT_TYPE_CHECKS = new Map<string, OwnershipStep>([
  ['data:find_tool_call', checkToolCallParentMessage],
  ['data:insert_tool_call', checkToolCallParentMessage],
  ['data:update_message', checkUpdateMessage],
  [
    'data:get_tool_call',
    (ctx) => checkToolCallId(stringOrUndefined(ctx.data?.toolCallId), ctx.userId),
  ],
  [
    'data:update_tool_call_output',
    (ctx) => checkToolCallId(stringOrUndefined(ctx.payload?.toolCallId), ctx.userId),
  ],
  ['data:cancel_queued_message', checkQueuedMessage],
  ['data:update_queued_message', checkQueuedMessage],
  ['data:watcher_update', checkWatcher],
  ['data:watcher_get', checkWatcher],
  ['data:job_update', checkJob],
  ['data:job_get', checkJob],
  ['data:resolve_pending_permission_request', checkPendingPermission],
  ['data:expire_pending_permission_request', checkPendingPermission],
]);

function typeSpecific(checks: ReadonlyMap<string, OwnershipStep>): OwnershipStep {
  return (ctx) => checks.get(ctx.data?.type)?.(ctx) ?? null;
}

/** Ordered pipeline; the first denial wins. */
const OWNERSHIP_STEPS: readonly OwnershipStep[] = [
  checkExplicitUserId,
  checkThread,
  typeSpecific(PRE_PROJECT_TYPE_CHECKS),
  checkProject,
  typeSpecific(POST_PROJECT_TYPE_CHECKS),
];

// Types that do not reference any user-scoped entity. Runners without an
// owning user (legacy rows where runners.user_id is NULL) can still access
// these — everything else requires a known owner.
const USER_NEUTRAL_TYPES = new Set<string>([
  'data:get_agent_template',
  'data:mark_and_list_stale_threads',
]);

/**
 * Verify that the runner owning `runnerUserId` is allowed to touch the
 * user/thread/project/message/tool-call referenced by `data`. Checks
 * short-circuit on the first mismatch.
 */
export async function assertDataOwnership(
  runnerUserId: string | null,
  data: any,
): Promise<OwnershipResult> {
  if (USER_NEUTRAL_TYPES.has(data?.type)) return OK;
  if (!runnerUserId) return deny('runner has no owning user');

  const ctx: OwnershipContext = { userId: runnerUserId, data, payload: data?.payload ?? {} };
  for (const step of OWNERSHIP_STEPS) {
    const denial = await step(ctx);
    if (denial) return denial;
  }
  return OK;
}
