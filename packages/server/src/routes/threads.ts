/**
 * Thread routes for the central server.
 *
 * Data CRUD (list, get, update, delete) is handled natively using the server's DB.
 * Agent operations (create+start, stop, send message) are proxied to the runner.
 */

import type { CommentAuthor, ThreadComment } from '@funny/shared';
import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import {
  createThreadRepository,
  createMessageRepository,
  createCommentRepository,
  createStageHistoryRepository,
  createToolCallRepository,
  createThreadShareRepository,
} from '@funny/shared/repositories';
import { THREAD_COMMENT_EVENT, THREAD_COMMENT_DELETED_EVENT } from '@funny/shared/socket-events';
import { inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import { authorizer } from '../lib/server-authorizer.js';
import { startSpan } from '../lib/telemetry.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import { canSteerThread, createThreadAccessMiddleware } from '../middleware/thread-access.js';
import * as messageQueueRepo from '../services/message-queue-repository.js';
import { findRunnerForProject } from '../services/runner-manager.js';
import * as runnerResolver from '../services/runner-resolver.js';
import type { ResolvedRunner } from '../services/runner-resolver.js';
import * as threadEventRepo from '../services/thread-event-repository.js';
import * as threadRegistry from '../services/thread-registry.js';
import { relayToUser, relayToThreadViewers } from '../services/ws-relay.js';
import { tunnelFetch } from '../services/ws-tunnel.js';
import { parseJsonBody, parseQuery } from '../validation/request.js';

// Canonical thread-lifecycle enums — kept in sync with
// @funny/shared/primitives (ThreadStatus / ThreadStage). Inlined as
// arrays so the route can validate at the HTTP boundary without
// pulling a runtime value from a types-only package.
const THREAD_STATUS_VALUES = [
  'setting_up',
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
] as const;

const THREAD_STAGE_VALUES = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
] as const;

const contentBodySchema = z
  .object({
    content: z.unknown().optional(),
  })
  .passthrough();

const threadPatchBodySchema = z.record(z.string(), z.unknown());

const threadValueBodySchema = z
  .object({
    value: z.unknown().optional(),
    reason: z.unknown().optional(),
  })
  .passthrough();

const threadWorkflowEventBodySchema = z
  .object({
    type: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const threadCreateBodySchema = z.record(z.string(), z.unknown());

const orchestratorWorkflowEventBodySchema = z
  .object({
    event: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const threadDetailQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).max(200).optional(),
  messageProgress: z.coerce.number().min(0).max(1).optional(),
});

// Read at call time, not module load — the test harness sets this in a
// per-file top-of-module assignment, but `routes/threads.ts` may have already
// been imported by an earlier test file via the shared test-app helper, so
// capturing it as a top-level constant freezes whatever value `process.env`
// happened to hold at first load (commonly undefined → crypto signing throws).
function getRunnerAuthSecret(): string {
  return process.env.RUNNER_AUTH_SECRET ?? '';
}

// ── Shared repository instances ──────────────────────────────────

const commentRepo = createCommentRepository({ db, schema: schema as any, dbAll, dbRun });
const stageHistoryRepo = createStageHistoryRepository({ db, schema: schema as any, dbRun });
const threadRepo = createThreadRepository({
  db,
  schema: schema as any,
  dbAll,
  dbGet,
  dbRun,
  commentRepo,
  stageHistoryRepo,
});
const messageRepo = createMessageRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });
const toolCallRepo = createToolCallRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });
const shareRepo = createThreadShareRepository({ db, schema: schema as any, dbAll, dbRun });

// Centralized per-thread authorization (see middleware/thread-access.ts).
// `requireThreadView` guards read routes (owner OR active share grant);
// `requireThreadOwner` guards mutation/lifecycle routes. The two hot-path reads
// (GET /:id and /:id/events) authorize inline via `canViewThread` to keep their
// single/parallel fetch.
// `requireThreadOwner` is also exported so the git-route gate in index.ts can
// reuse the same owner check (git ops must stay owner-only — a sharee never
// reaches another user's runner; see thread-sharing design).
export const { requireThreadView, requireThreadOwner, requireThreadSteer } =
  createThreadAccessMiddleware(
    (id) => threadRepo.getThread(id),
    // View: effective role with thread→project→org inheritance (unified-rbac).
    (thread, userId) => authorizer.authorize(userId, 'thread', thread.id, 'view'),
    // Steer: owner OR explicit thread steer grant ONLY — inheritance must NOT
    // cross runner isolation, so this stays `canSteerThread` (unchanged behavior).
    (thread, userId) => canSteerThread(thread, userId, shareRepo.getShareLevel),
  );

// ── Runner communication helpers ─────────────────────────────────

async function resolveRunnerForProject(
  projectId: string,
  userId?: string,
): Promise<ResolvedRunner | null> {
  // CRITICAL (runner isolation): scope the project→runner lookup to the
  // requesting user. Without userId, findRunnerForProject returns ANY runner
  // assigned to the project — including another user's runner — which then gets
  // cached as the thread's runner and routes every request cross-tenant (the
  // server's data-handler correctly refuses, breaking the thread). A
  // collaborator must run on THEIR OWN runner.
  const runnerResult = await findRunnerForProject(projectId, userId);
  if (runnerResult) {
    return {
      runnerId: runnerResult.runner.runnerId,
      httpUrl: runnerResult.runner.httpUrl ?? null,
    };
  }
  return await runnerResolver.resolveRunner('/api/threads', { projectId }, userId);
}

async function fetchFromRunner(
  resolved: ResolvedRunner,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  if (resolved.runnerId === '__default__' && resolved.httpUrl) {
    return await directFetch(resolved.httpUrl, path, opts);
  }

  try {
    const resp = await tunnelFetch(resolved.runnerId, {
      method: opts.method,
      path,
      headers: opts.headers,
      body: opts.body ?? null,
    });
    return {
      ok: resp.status >= 200 && resp.status < 400,
      status: resp.status,
      body: resp.body ?? '',
    };
  } catch (tunnelErr) {
    if (resolved.httpUrl) {
      log.warn('Tunnel failed, falling back to direct HTTP', {
        namespace: 'threads',
        runnerId: resolved.runnerId,
        error: (tunnelErr as Error).message,
      });
      return await directFetch(resolved.httpUrl, path, opts);
    }
    throw tunnelErr;
  }
}

async function directFetch(
  baseUrl: string,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers: opts.headers,
    body: opts.method !== 'GET' && opts.method !== 'HEAD' ? opts.body : undefined,
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

function buildForwardHeaders(
  userId: string,
  orgId?: string,
  role?: string,
  orgName?: string,
): Record<string, string> {
  // Default role to 'user' so the signed payload matches what the runtime
  // verifies (runtime defaults a missing X-Forwarded-Role to 'user' too).
  const effectiveRole = role ?? 'user';
  const runnerAuthSecret = getRunnerAuthSecret();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': userId,
    'X-Runner-Auth': runnerAuthSecret,
    'X-Forwarded-Role': effectiveRole,
  };
  if (orgId) headers['X-Forwarded-Org'] = orgId;
  if (orgName) headers['X-Forwarded-Org-Name'] = orgName;
  const { signature, timestamp, nonce } = signForwardedIdentity(
    { userId, role: effectiveRole, orgId: orgId ?? null, orgName: orgName ?? null },
    runnerAuthSecret,
  );
  headers[SIGNATURE_HEADER] = signature;
  headers[TIMESTAMP_HEADER] = String(timestamp);
  headers[NONCE_HEADER] = nonce;
  return headers;
}

export const threadRoutes = new Hono<ServerEnv>();

// ── Data CRUD routes (handled natively) ──────────────────────────

// GET /api/threads?projectId=xxx&includeArchived=true&limit=50&offset=0&isScratch=true
threadRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.query('projectId');
  const designId = c.req.query('designId');
  const includeArchived = c.req.query('includeArchived') === 'true';
  // Scratch filter is opt-in. When listing by project, exclude scratch
  // threads so they never leak into the project sidebar.
  const isScratchParam = c.req.query('isScratch');
  const isScratch: boolean | 'exclude' | undefined =
    isScratchParam === 'true' ? true : projectId ? 'exclude' : undefined;
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  // Span on the native list path (mirrors GET /:id). Its start_time_ms reveals
  // WHEN the server began handling each sidebar list during app refresh — if the
  // ~28 per-project lists start spread across the load window the bottleneck is
  // upstream (browser per-origin socket queue / proxy); if they start clustered
  // but the span durations stack, it's server-side DB serialization.
  const span = startSpan('GET /api/threads', {
    attributes: {
      'thread.project_id': projectId ?? null,
      'thread.limit': limit,
      'thread.offset': offset,
    },
  });
  try {
    const { threads, total } = await threadRepo.listThreads({
      projectId: projectId || undefined,
      designId: designId || undefined,
      userId,
      includeArchived,
      organizationId: orgId,
      isScratch,
      limit,
      offset,
    });

    span.attributes['thread.count'] = threads.length;
    span.attributes['thread.total'] = Number(total);
    span.end('ok');
    return c.json({ threads, total, hasMore: offset + threads.length < total });
  } catch (e) {
    span.end('error', e instanceof Error ? e.message : String(e));
    throw e;
  }
});

// GET /api/threads/scratch — list the current user's scratch threads
threadRoutes.get('/scratch', async (c) => {
  const userId = c.get('userId') as string;
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  const { threads, total } = await threadRepo.listThreads({
    userId,
    isScratch: true,
    includeArchived: false,
    limit,
    offset,
  });

  return c.json({ threads, total, hasMore: offset + threads.length < total });
});

// GET /api/threads/archived?page=1&limit=100&search=xxx
threadRoutes.get('/archived', async (c) => {
  const userId = c.get('userId') as string;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
  const search = c.req.query('search')?.trim() || '';
  const projectId = c.req.query('projectId')?.trim() || undefined;

  const result = await threadRepo.listArchivedThreads({ page, limit, search, userId, projectId });
  return c.json({ ...result, page, limit });
});

// GET /api/threads/:id — get thread with messages
threadRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const parsedQuery = parseQuery(c, threadDetailQuerySchema);
  if (parsedQuery.isErr()) return c.json({ error: parsedQuery.error.message }, 400);
  const { messageLimit, messageProgress } = parsedQuery.value;

  const span = startSpan('GET /api/threads/:id', {
    attributes: {
      'thread.id': id,
      'thread.message_limit': messageLimit ?? null,
      'thread.message_progress': messageProgress ?? null,
    },
  });
  try {
    // Fetch thread+messages, queue count, and queue head in parallel.
    // Ownership is checked off the thread row inside the same query result,
    // so we avoid a separate getThread() round-trip.
    const fetchSpan = startSpan('thread.fetch_with_messages', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const queueCountSpan = startSpan('thread.queue_count', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const queuePeekSpan = startSpan('thread.queue_peek', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const [result, queuedCount, queuedNext] = await Promise.all([
      messageRepo
        .getThreadWithMessages(id, messageLimit, { messageProgress })
        .finally(() => fetchSpan.end('ok')),
      messageQueueRepo.queueCount(id).finally(() => queueCountSpan.end('ok')),
      messageQueueRepo.peek(id).finally(() => queuePeekSpan.end('ok')),
    ]);

    if (!result || !(await authorizer.authorize(userId, 'thread', result.id, 'view'))) {
      span.end('ok');
      return c.json({ error: 'Thread not found' }, 404);
    }

    // Expose the VIEWER's own grant level so the client can gate level-specific
    // affordances (comment box, PromptInput, git read panel). The owner gets
    // `null` (not a sharee); a sharee gets 'view' | 'comment' | 'steer'.
    const viewerShareLevel =
      result.userId === userId ? null : await shareRepo.getShareLevel(id, userId);

    span.attributes['thread.message_count'] = result.messages?.length ?? 0;
    span.attributes['thread.queued_count'] = queuedCount;
    span.end('ok');
    return c.json({
      ...result,
      queuedCount,
      queuedNextMessage: queuedNext?.content,
      viewerShareLevel,
    });
  } catch (e) {
    span.end('error', e instanceof Error ? e.message : String(e));
    throw e;
  }
});

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50&direction=before|after
threadRoutes.get('/:id/messages', requireThreadView, async (c) => {
  const id = c.req.param('id');

  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '50', 10)));
  const direction = c.req.query('direction') === 'after' ? 'after' : 'before';

  const result = await messageRepo.getThreadMessages({
    threadId: id,
    cursor: cursor || undefined,
    limit,
    direction,
  });
  return c.json(result);
});

// GET /api/threads/:id/messages/search?q=xxx&limit=100
threadRoutes.get('/:id/messages/search', requireThreadView, async (c) => {
  const id = c.req.param('id');

  const q = c.req.query('q') || '';
  const limitParam = c.req.query('limit');
  const limit = Math.min(200, Math.max(1, parseInt(limitParam || '100', 10)));
  const caseSensitive = c.req.query('caseSensitive') === 'true';

  if (!q.trim()) {
    return c.json({ results: [] });
  }

  const results = await messageRepo.searchMessages({
    threadId: id,
    query: q.trim(),
    limit,
    caseSensitive,
  });
  return c.json({ results });
});

// Join author display info (name/image) onto a set of comments so the client
// can render avatars + names without a second round-trip. Mirrors the
// enrichment done for share grants in routes/thread-shares.ts.
async function authorsByIds(userIds: string[]): Promise<Map<string, CommentAuthor>> {
  if (userIds.length === 0) return new Map();
  const rows = await dbAll(
    db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        image: schema.user.image,
        username: schema.user.username,
      })
      .from(schema.user)
      .where(inArray(schema.user.id, userIds)),
  );
  return new Map(rows.map((u: any) => [u.id, u as CommentAuthor]));
}

// GET /api/threads/:id/comments
threadRoutes.get('/:id/comments', requireThreadView, async (c) => {
  const id = c.req.param('id');

  const comments = (await commentRepo.listComments(id)) as ThreadComment[];
  const authors = await authorsByIds([...new Set(comments.map((cm) => cm.userId))]);
  return c.json(comments.map((cm) => ({ ...cm, user: authors.get(cm.userId) ?? null })));
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', requireThreadView, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  // Posting a comment needs the `comment` capability (commenter+): a plain
  // viewer can read the thread and its comments but not post. They already see
  // the thread, so this is an honest 403 rather than existence-hiding 404.
  if (!(await authorizer.authorize(userId, 'thread', id, 'comment'))) {
    return c.json({ error: 'You do not have permission to comment on this thread' }, 403);
  }

  const parsed = await parseJsonBody(c, contentBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { content } = parsed.value;

  if (!content || typeof content !== 'string' || !content.trim()) {
    return c.json({ error: 'content is required' }, 400);
  }

  const inserted = await commentRepo.insertComment({
    threadId: id,
    userId,
    source: 'user',
    content,
  });
  const authors = await authorsByIds([userId]);
  const comment: ThreadComment = {
    ...inserted,
    user: authors.get(userId) ?? null,
  } as ThreadComment;

  // Live append for every current viewer (owner + sharees) via the thread's
  // presence room. The client also refetches on panel open as a backstop.
  relayToThreadViewers(id, { type: THREAD_COMMENT_EVENT, threadId: id, comment });

  return c.json(comment, 201);
});

// DELETE /api/threads/:id/comments/:commentId
threadRoutes.delete('/:id/comments/:commentId', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  await commentRepo.deleteComment(commentId);
  relayToThreadViewers(id, { type: THREAD_COMMENT_DELETED_EVENT, threadId: id, commentId });
  return c.json({ ok: true });
});

// Thread sharing routes (`/:id/shares`, `/shared-with-me`) live in
// routes/thread-shares.ts and are mounted alongside this router in index.ts.

// PATCH /api/threads/:id — update thread data
threadRoutes.patch('/:id', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, threadPatchBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  const thread = c.get('thread');

  // Security CR-4: `worktreePath` is intentionally NOT in the PATCH allow-
  // list. It is set exclusively by the runtime's `createWorktree` flow and
  // identifies a directory the runner trusts as a cwd for agent spawn,
  // browse, ripgrep, and uploads. Letting clients overwrite it lets them
  // pivot the runner to `/etc`, another user's HOME, etc., bypassing
  // path-scope checks.
  const allowedFields = [
    'title',
    'status',
    'stage',
    'archived',
    'pinned',
    'orchestratorManaged',
    'model',
    'mode',
    'branch',
    'baseBranch',
    'permissionMode',
    'provider',
  ];
  const updates: Record<string, any> = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) {
      updates[key] = body[key];
    }
  }

  // PostgreSQL integer columns need boolean → integer conversion
  if (typeof updates.pinned === 'boolean') updates.pinned = updates.pinned ? 1 : 0;
  if (typeof updates.archived === 'boolean') updates.archived = updates.archived ? 1 : 0;
  if (typeof updates.orchestratorManaged === 'boolean') {
    updates.orchestratorManaged = updates.orchestratorManaged ? 1 : 0;
  }

  if (Object.keys(updates).length > 0) {
    await threadRepo.updateThread(id, updates);
  }

  // Kanban drag moves and archive/unarchive both flow through this route.
  // Record the stage transition (movement trail / analytics) and broadcast a
  // thread:stage-changed event so every tab's board updates live — the same
  // contract the dedicated /:id/stage route (used by pipelines) already honors.
  const fromStage = thread.stage ?? null;
  const stageMoved = 'stage' in updates && updates.stage !== fromStage;
  const archivedNow = 'archived' in updates && updates.archived === 1 && !thread.archived;
  const unarchivedNow = 'archived' in updates && updates.archived === 0 && !!thread.archived;

  let transitionFrom: string | null = fromStage;
  let transitionTo: string | null = null;
  if (archivedNow) {
    transitionTo = 'archived';
  } else if (unarchivedNow) {
    transitionFrom = 'archived';
    transitionTo = (updates.stage as string | undefined) ?? thread.stage ?? 'backlog';
  } else if (stageMoved) {
    transitionTo = updates.stage as string;
  }

  if (transitionTo !== null && transitionTo !== transitionFrom) {
    await stageHistoryRepo.recordStageChange(id, transitionFrom, transitionTo);
    relayToUser(userId, {
      type: 'thread:stage-changed',
      threadId: id,
      data: { fromStage: transitionFrom, toStage: transitionTo, projectId: thread.projectId },
    });
    log.info('Thread stage transition recorded via PATCH', {
      namespace: 'threads',
      threadId: id,
      fromStage: transitionFrom,
      toStage: transitionTo,
    });
  }

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

// ── Lifecycle endpoints used by the YAML pipeline DSL ───────
//
// `set_status` / `set_stage` actions in `.funny/pipelines/*.yaml`
// post to these routes (when the pipeline runs server-side, e.g. in
// the orchestrator's tunnel adapter). Dedicated endpoints — instead
// of relying on PATCH /:id — give us strict enum validation and a
// single emission point for the WS event that the kanban UI listens
// on.
threadRoutes.patch('/:id/status', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, threadValueBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;

  if (typeof body.value !== 'string') {
    return c.json({ error: 'Missing required string field "value"' }, 400);
  }
  if (!(THREAD_STATUS_VALUES as readonly string[]).includes(body.value)) {
    return c.json(
      {
        error: `Invalid status "${body.value}". Allowed: ${THREAD_STATUS_VALUES.join(', ')}`,
      },
      400,
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  await threadRepo.updateThread(id, { status: body.value });
  relayToUser(userId, {
    type: 'thread:updated',
    threadId: id,
    data: { status: body.value, reason },
  });

  log.info('Thread status patched', {
    namespace: 'threads',
    threadId: id,
    status: body.value,
    reason,
  });

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

threadRoutes.patch('/:id/stage', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, threadValueBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;

  if (typeof body.value !== 'string') {
    return c.json({ error: 'Missing required string field "value"' }, 400);
  }
  if (!(THREAD_STAGE_VALUES as readonly string[]).includes(body.value)) {
    return c.json(
      {
        error: `Invalid stage "${body.value}". Allowed: ${THREAD_STAGE_VALUES.join(', ')}`,
      },
      400,
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const thread = c.get('thread');
  const fromStage = thread.stage;
  await threadRepo.updateThread(id, { stage: body.value });
  if (body.value !== fromStage) {
    await stageHistoryRepo.recordStageChange(id, fromStage ?? null, body.value);
    relayToUser(userId, {
      type: 'thread:stage-changed',
      threadId: id,
      data: {
        fromStage,
        toStage: body.value,
        projectId: thread.projectId,
        reason,
      },
    });
  }

  log.info('Thread stage patched', {
    namespace: 'threads',
    threadId: id,
    fromStage,
    toStage: body.value,
    reason,
  });

  const updated = await threadRepo.getThread(id);
  return c.json(updated);
});

// ── Workflow event fan-out (orchestrator-bound) ─────────────
//
// The (co-located) orchestrator binary posts here when a pipeline step
// emits a generic message — `notify` actions, log lines, etc. The server
// persists the event as a thread:event in the DB and broadcasts the same
// envelope shape used by emitWorkflowEvent in the runtime, so existing
// client listeners work unchanged.
threadRoutes.post('/:id/workflow-event', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const parsed = await parseJsonBody(c, threadWorkflowEventBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;

  if (typeof body.type !== 'string' || !body.type) {
    return c.json({ error: 'Missing required string field "type"' }, 400);
  }
  // Constrain the event type to the workflow:* / pipeline:* namespaces so
  // a forwarded user can't synthesize unrelated events (eg. agent:result).
  if (!body.type.startsWith('workflow:') && !body.type.startsWith('pipeline:')) {
    return c.json({ error: 'type must start with "workflow:" or "pipeline:"' }, 400);
  }
  const data: Record<string, unknown> =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};

  await threadEventRepo.saveThreadEvent(id, body.type, data);

  // Mirror broadcastThreadEvent shape from packages/runtime/src/services/workflow-event-helpers.ts
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  relayToUser(userId, {
    type: 'thread:event',
    threadId: id,
    data: {
      event: {
        id: eventId,
        threadId: id,
        type: body.type,
        data: JSON.stringify(data),
        createdAt,
      },
    },
  });

  return c.json({ ok: true, eventId });
});

// ── Thread creation (proxied to runner, then registered locally) ─

/** Shared handler for creating threads on a runner and registering them locally. */
async function createThreadOnRunner(c: any, runnerPath: string) {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, threadCreateBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const rawBody = parsed.value;
  const isScratch = rawBody.isScratch === true;

  // Validate scratch invariants before any I/O.
  if (isScratch && rawBody.projectId != null) {
    return c.json(
      {
        error: 'Scratch threads cannot have a project',
        code: 'scratch-thread-cannot-have-project',
      },
      400,
    );
  }
  if (isScratch && rawBody.mode && rawBody.mode !== 'local') {
    return c.json(
      { error: 'Scratch threads must use mode = local', code: 'scratch-thread-must-be-local' },
      400,
    );
  }

  // Normalize scratch body so the runtime sees a consistent shape.
  const body = isScratch
    ? { ...rawBody, projectId: null, mode: 'local' as const, isScratch: true }
    : rawBody;
  const projectId = body.projectId as string | null;

  if (!isScratch && !projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  // Resolve the runner. Scratch threads have no project, so we ask
  // resolveRunner for any reachable runner that belongs to this user.
  const resolved = isScratch
    ? await runnerResolver.resolveRunner(runnerPath, {}, userId)
    : await resolveRunnerForProject(projectId!, userId);
  if (!resolved) {
    return c.json(
      {
        error: isScratch
          ? 'No online runner found for this user'
          : 'No online runner found for this project',
      },
      502,
    );
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const result = await fetchFromRunner(resolved, runnerPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const threadData = JSON.parse(result.body);

    const threadId = threadData.id || threadData.thread?.id;
    if (threadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: resolved.runnerId,
        userId,
        title: typeof body.title === 'string' && body.title ? body.title : threadData.title,
        model: typeof body.model === 'string' ? body.model : undefined,
        mode: typeof body.mode === 'string' ? body.mode : undefined,
        // Use runtime response data — the runtime generates the worktree
        // branch name, so body.branch is typically undefined for new threads.
        branch:
          threadData.branch ??
          (typeof body.branch === 'string' && body.branch ? body.branch : undefined),
        isScratch,
      });

      runnerResolver.cacheThreadRunner(threadId, userId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(threadData, 201);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const stack = (err as Error).stack;
    log.error('Failed to create thread on runner', {
      namespace: 'threads',
      error: message,
      stack,
      path: runnerPath,
    });
    return c.json({ error: 'Thread creation failed' }, 502);
  }
}

// POST /api/threads — Create a new thread
threadRoutes.post('/', (c) => createThreadOnRunner(c, '/api/threads'));

// POST /api/threads/idle — Create an idle thread
threadRoutes.post('/idle', (c) => createThreadOnRunner(c, '/api/threads/idle'));

// ── Agent operations (proxied to runner) ─────────────────────────

// POST /api/threads/:id/orchestrator/workflow-event — orchestrator-bound
// Generic event fan-out for the standalone orchestrator. Mirrors the
// in-process pipeline-adapter's `notify()` path: the orchestrator pushes
// a workflow event here and the server relays it to the user's browser
// clients via Socket.IO.
threadRoutes.post('/:id/orchestrator/workflow-event', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsed = await parseJsonBody(c, orchestratorWorkflowEventBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  const event = body.event;
  if (typeof event !== 'string' || !event.startsWith('workflow:')) {
    return c.json({ error: 'event must be a string starting with "workflow:"' }, 400);
  }

  relayToUser(userId, {
    type: event,
    threadId,
    data: { ...((body.data ?? {}) as Record<string, unknown>) },
  });

  return c.json({ ok: true });
});

// POST /api/threads/:id/message — send message to running agent.
// ALLOW-LISTED for steer sharees (thread-sharing-steer): owner OR a sharee
// whose grant level is `steer`. This is one of only two runner-bound actions a
// non-owner may reach; the gate runs BEFORE proxyToRunner so a `view` sharee /
// non-sharee gets 404 here instead of crossing runner isolation.
threadRoutes.post('/:id/message', requireThreadSteer, proxyToRunner);

// POST /api/threads/:id/upload — upload a user-attached file to the runner.
// Owner-only: writes a file onto the owner's machine. NOT part of the steer
// allow-list. The explicit owner gate replaces the previous reliance on runner
// isolation (which steer resolution now crosses).
threadRoutes.post('/:id/upload', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/stop — stop running agent. Owner-only (not steer).
threadRoutes.post('/:id/stop', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/approve-tool — approve a tool call. Owner-only:
// authorizes command execution on the owner's machine. Never steer.
threadRoutes.post('/:id/approve-tool', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/convert-to-worktree — convert local thread to worktree.
// Owner-only git operation.
threadRoutes.post('/:id/convert-to-worktree', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/fork — fork conversation at a user message
threadRoutes.post('/:id/fork', requireThreadOwner, async (c) => {
  const sourceThreadId = c.req.param('id');
  const userId = c.get('userId') as string;

  const source = c.get('thread');

  const resolved = await resolveRunnerForProject(source.projectId, userId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const body = await c.req.text();
    const result = await fetchFromRunner(resolved, `/api/threads/${sourceThreadId}/fork`, {
      method: 'POST',
      headers,
      body,
    });

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const newThread = JSON.parse(result.body);
    const newThreadId = newThread?.id;
    if (newThreadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: newThreadId,
        projectId: source.projectId,
        runnerId: resolved.runnerId,
        userId,
        title: newThread.title,
        model: newThread.model,
        mode: newThread.mode,
        branch: newThread.branch ?? undefined,
      });
      runnerResolver.cacheThreadRunner(newThreadId, userId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(newThread, 201);
  } catch (err) {
    log.error('Failed to fork thread on runner', {
      namespace: 'threads',
      sourceThreadId,
      error: (err as Error).message,
    });
    return c.json({ error: 'Thread fork failed' }, 502);
  }
});

// POST /api/threads/:id/rewind — proxy to runner. Owner-only: mutates the
// owner's worktree. Not part of the steer allow-list.
threadRoutes.post('/:id/rewind', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/fork-and-rewind — fork conversation, then rewind code
threadRoutes.post('/:id/fork-and-rewind', requireThreadOwner, async (c) => {
  const sourceThreadId = c.req.param('id');
  const userId = c.get('userId') as string;

  const source = c.get('thread');

  const resolved = await resolveRunnerForProject(source.projectId, userId);
  if (!resolved) {
    return c.json({ error: 'No online runner found for this project' }, 502);
  }

  try {
    const headers = buildForwardHeaders(
      userId,
      c.get('organizationId') as string | undefined,
      c.get('userRole') as string | undefined,
      c.get('organizationName') as string | undefined,
    );
    const body = await c.req.text();
    const result = await fetchFromRunner(
      resolved,
      `/api/threads/${sourceThreadId}/fork-and-rewind`,
      { method: 'POST', headers, body },
    );

    if (!result.ok) {
      return c.json({ error: `Runner error: ${result.body}` }, result.status as any);
    }

    const parsed = JSON.parse(result.body);
    const newThread = parsed?.thread ?? null;
    const newThreadId = newThread?.id;
    if (newThreadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: newThreadId,
        projectId: source.projectId,
        runnerId: resolved.runnerId,
        userId,
        title: newThread.title,
        model: newThread.model,
        mode: newThread.mode,
        branch: newThread.branch ?? undefined,
      });
      runnerResolver.cacheThreadRunner(newThreadId, userId, resolved.runnerId, resolved.httpUrl);
    }

    return c.json(parsed, 201);
  } catch (err) {
    log.error('Failed to fork-and-rewind thread on runner', {
      namespace: 'threads',
      sourceThreadId,
      error: (err as Error).message,
    });
    return c.json({ error: 'Thread fork-and-rewind failed' }, 502);
  }
});

// PATCH /api/threads/:id/tool-calls/:toolCallId — update tool call output.
// Owner-only: mutates agent execution state. Not part of the steer allow-list.
threadRoutes.patch('/:id/tool-calls/:toolCallId', requireThreadOwner, proxyToRunner);

// GET /api/threads/:id/events — served from server DB
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const span = startSpan('GET /api/threads/:id/events', {
    attributes: { 'thread.id': id },
  });
  try {
    // Run the ownership lookup and the events query in parallel — events
    // is the slow leg and can't read user data we wouldn't already return.
    const { getThreadEvents } = await import('../services/thread-event-repository.js');
    const ownerSpan = startSpan('thread.owner_check', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const eventsSpan = startSpan('thread.events.fetch', {
      traceId: span.traceId,
      parentSpanId: span.spanId,
      attributes: { 'thread.id': id },
    });
    const [thread, events] = await Promise.all([
      threadRepo.getThread(id).finally(() => ownerSpan.end('ok')),
      getThreadEvents(id).finally(() => eventsSpan.end('ok')),
    ]);

    if (!thread || !(await authorizer.authorize(userId, 'thread', thread.id, 'view'))) {
      span.end('ok');
      return c.json({ error: 'Thread not found' }, 404);
    }

    span.attributes['thread.events_count'] = events.length;
    span.end('ok');
    return c.json({ events });
  } catch (e) {
    span.end('error', e instanceof Error ? e.message : String(e));
    throw e;
  }
});

// GET /api/threads/:id/touched-files — all unique file paths modified by Write/Edit/NotebookEdit
threadRoutes.get('/:id/touched-files', requireThreadView, async (c) => {
  const id = c.req.param('id');

  const files = await toolCallRepo.getTouchedFiles(id);
  return c.json({ files });
});

// GET /api/threads/:id/queue — message queue is in the server's DB
threadRoutes.get('/:id/queue', requireThreadView, async (c) => {
  const id = c.req.param('id');

  return c.json(await messageQueueRepo.listQueue(id));
});

// DELETE /api/threads/:id/queue/:messageId — cancel a queued message
threadRoutes.delete('/:id/queue/:messageId', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');

  const success = await messageQueueRepo.cancel(messageId, id);
  const queuedCount = await messageQueueRepo.queueCount(id);
  return c.json({ ok: success, queuedCount });
});

// PATCH /api/threads/:id/queue/:messageId — update a queued message
threadRoutes.patch('/:id/queue/:messageId', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const messageId = c.req.param('messageId');

  const parsed = await parseJsonBody(c, contentBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { content } = parsed.value;
  if (!content || typeof content !== 'string') {
    return c.json({ error: 'content is required' }, 400);
  }
  const updated = await messageQueueRepo.update(messageId, id, content);
  const queuedCount = await messageQueueRepo.queueCount(id);
  return c.json({ ok: !!updated, queuedCount, message: updated });
});

// ── Delete thread (native + proxy cleanup) ───────────────────────

threadRoutes.delete('/:id', requireThreadOwner, async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId') as string;

  // Delete from local DB
  await threadRepo.deleteThread(threadId);

  // Find which runner handles this thread and clean up there too
  const runnerInfo = await threadRegistry.getRunnerForThread(threadId, userId);

  // Unregister from central DB and cache
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // Proxy the delete to the runner
  if (runnerInfo) {
    const resolved: ResolvedRunner = {
      runnerId: runnerInfo.runnerId,
      httpUrl: runnerInfo.httpUrl,
    };
    try {
      const headers = buildForwardHeaders(
        userId,
        c.get('organizationId') as string | undefined,
        c.get('userRole') as string | undefined,
        c.get('organizationName') as string | undefined,
      );
      await fetchFromRunner(resolved, `/api/threads/${threadId}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Runner may be offline — that's ok, we already cleaned up the central DB
    }
  }

  return c.json({ ok: true });
});

// GET /api/threads/search/content?q=xxx&projectId=xxx&caseSensitive=true
threadRoutes.get('/search/content', async (c) => {
  const userId = c.get('userId') as string;
  const q = c.req.query('q') || '';
  const projectId = c.req.query('projectId');
  const caseSensitive = c.req.query('caseSensitive') === 'true';

  if (!q.trim()) {
    return c.json({ threadIds: [], snippets: {} });
  }

  const { searchThreadIdsByContent } = await import('../services/search-repository.js');
  const results = await searchThreadIdsByContent({ query: q, projectId, userId, caseSensitive });

  const threadIds = Array.from(results.keys());
  const snippets: Record<string, string> = {};
  for (const [id, snippet] of results) {
    snippets[id] = snippet;
  }

  return c.json({ threadIds, snippets });
});
