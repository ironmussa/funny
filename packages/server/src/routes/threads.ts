/**
 * Thread routes for the central server.
 *
 * Comments, deletion and workflow events are handled natively
 * using the server's DB; lists, detail, messages and field updates are tRPC
 * procedures (their REST paths answer 404).
 * Agent operations (create+start, stop, send message) are proxied to the runner.
 */

import type { JsonObject } from '@bufbuild/protobuf';
import type { CommentAuthor, CommentSource, Thread, ThreadComment } from '@funny/shared';
import { threadCommentsQuery, threadDeleteQuery } from '@funny/shared/contracts/threads';
import { THREAD_COMMENT_EVENT, THREAD_COMMENT_DELETED_EVENT } from '@funny/shared/socket-events';
import { inArray } from 'drizzle-orm';
import { Hono, type Context, type Next } from 'hono';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import { db, dbAll } from '../db/index.js';
import { repos } from '../db/repos.js';
import * as schema from '../db/schema.js';
import { log } from '../lib/logger.js';
import { authorizer } from '../lib/server-authorizer.js';
import { startSpan } from '../lib/telemetry.js';
import { toThread } from '../lib/thread-response.js';
import type { ServerEnv } from '../lib/types.js';
import { isObject, isString } from '../lib/value-guards.js';
import { proxyToRunner } from '../middleware/proxy.js';
import {
  canSteerThread,
  createThreadAccess,
  threadAccessMiddlewareFrom,
} from '../middleware/thread-access.js';
import {
  composeCreateThread,
  composeForkThread,
  runnerPathFor,
} from '../modules/threads/composition.js';
import {
  authenticatedUserId,
  authorizedThreadId,
  withForkInputs,
  threadOwnedBy,
  type CreationIntent,
  type CreationPayload,
  type ForkVariant,
  type RunnerJson,
} from '../modules/threads/index.js';
import { forgetThreadOwnership } from '../services/data-ownership.js';
import { noteOwnerFollowUp } from '../services/factory/factory-follow-ups.js';
import * as messageQueueRepo from '../services/message-queue-repository.js';
import * as runnerResolver from '../services/runner-resolver.js';
import * as threadEventRepo from '../services/thread-event-repository.js';
import * as threadRegistry from '../services/thread-registry.js';
import { destroyThreadSandbox } from '../services/thread-sandboxes/sandbox-lifecycle.js';
import { sandboxThreadLauncherFor } from '../services/thread-sandboxes/sandbox-thread-wiring.js';
import { retrySandboxThreadSchema } from '../services/thread-sandboxes/sandbox-thread.js';
import {
  requestScratchCleanup,
  removesScratchOnDelete,
  requestThreadWorkspaceCleanup,
  workspaceToRemoveOnDelete,
} from '../services/thread-workspace-cleanup.js';
import { parseJsonBody } from '../validation/request.js';
import { refuseRetiredRoute } from './retired-rest.js';

const contentBodySchema = z
  .object({
    content: z.unknown().optional(),
  })
  .passthrough();

const threadWorkflowEventBodySchema = z
  .object({
    type: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const threadCreateBodySchema = z.record(z.string(), z.unknown());

// ── Shared repository instances ──────────────────────────────────

const commentRepo = repos.comments();
const threadRepo = repos.threads();
const toolCallRepo = repos.toolCalls();
const shareRepo = repos.threadShares();

// Centralized per-thread authorization (see middleware/thread-access.ts).
// `requireThreadView` guards read routes (owner OR active share grant);
// `requireThreadOwner` guards mutation/lifecycle routes. The two hot-path reads
// (GET /:id and /:id/events) authorize inline via `canViewThread` to keep their
// single/parallel fetch.
// `requireThreadOwner` is also exported so the git-route gate in index.ts can
// reuse the same owner check (git ops must stay owner-only — a sharee never
// reaches another user's runner; see thread-sharing design).
/** Shared with the tRPC thread procedures (`trpc/ports/thread-access.ts`). */
export const threadAccessPolicy = createThreadAccess(
  (id) => threadRepo.getThread(id),
  // View: effective role with thread→project→org inheritance (unified-rbac).
  (thread, userId) => authorizer.authorize(userId, 'thread', thread.id, 'view'),
  // Steer: owner OR explicit thread steer grant ONLY — inheritance must NOT
  // cross runner isolation, so this stays `canSteerThread` (unchanged behavior).
  (thread, userId) => canSteerThread(thread, userId, shareRepo.getShareLevel),
);
const threadAccess = threadAccessMiddlewareFrom(threadAccessPolicy);
const { requireThreadView } = threadAccess;
export const { requireThreadOwner, requireThreadSteer } = threadAccess;

export const threadRoutes = new Hono<ServerEnv>();

// ── Data CRUD routes (handled natively) ──────────────────────────

// ── Server-answered reads and field updates: tRPC only ─────────
// Lists, detail, messages, search and field updates are the `threads` tRPC
// procedures (`trpc/ports/threads.ts`, `/api/trpc/threads.*`), for every
// consumer (openspec adopt-trpc-browser-api). Their REST paths are refused
// here, never left to fall through: the runner proxy would forward them to the
// user's runner, which does not own the rows.
// Static segments come before `/:id` so they are not read as ids.
const REMOVED_THREAD_ROUTES = [
  ['GET', '/'],
  ['GET', '/scratch'],
  ['GET', '/archived'],
  ['GET', '/search/content'],
  ['GET', '/:id'],
  ['GET', '/:id/messages'],
  ['GET', '/:id/messages/search'],
  ['PATCH', '/:id'],
  ['PATCH', '/:id/permission-mode'],
  ['PATCH', '/:id/status'],
  ['PATCH', '/:id/stage'],
] as const;

for (const [method, path] of REMOVED_THREAD_ROUTES) {
  threadRoutes.on(method, path, refuseRetiredRoute);
}

// Join author display info (name/image) onto a set of comments so the client
// can render avatars + names without a second round-trip. Mirrors the
// enrichment done for share grants in routes/thread-shares.ts.
async function authorsByIds(userIds: string[]): Promise<Map<string, CommentAuthor>> {
  if (userIds.length === 0) return new Map();
  const rows = await dbAll<CommentAuthor>(
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
  return new Map(rows.map((u) => [u.id, u] as const));
}

type CommentRow = typeof schema.threadComments.$inferSelect;

/** A comment row as the shared `ThreadComment`, with its author joined in. */
function toThreadComment(row: CommentRow, authors: Map<string, CommentAuthor>): ThreadComment {
  return {
    id: row.id,
    threadId: row.threadId,
    userId: row.userId,
    // SAFETY: thread_comments.source is written only by insertComment, with 'user' (the
    // comment route) or 'system' (the runner's comment handler), both CommentSource values.
    source: row.source as CommentSource,
    content: row.content,
    createdAt: row.createdAt,
    user: authors.get(row.userId) ?? null,
  };
}

// GET /api/threads/:id/comments?limit=&offset=
// One page counted back from the newest comment, returned oldest first.
threadRoutes.get('/:id/comments', requireThreadView, async (c) => {
  const id = c.req.param('id');
  const page = threadCommentsQuery.parse(c.req.query());

  const rows: CommentRow[] = await commentRepo.listComments(id, page);
  const authors = await authorsByIds([...new Set(rows.map((cm) => cm.userId))]);
  return c.json(rows.map((row) => toThreadComment(row, authors)));
});

// POST /api/threads/:id/comments
threadRoutes.post('/:id/comments', requireThreadView, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

  // Posting a comment needs the `comment` capability (commenter+): a plain
  // viewer can read the thread and its comments but not post. They already see
  // the thread, so this is an honest 403 rather than existence-hiding 404.
  if (!(await authorizer.authorize(userId, 'thread', id, 'comment'))) {
    return c.json({ error: 'You do not have permission to comment on this thread' }, 403);
  }

  const parsed = await parseJsonBody(c, contentBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { content } = parsed.value;

  if (!content || !isString(content) || !content.trim()) {
    return c.json({ error: 'content is required' }, 400);
  }

  const inserted = await commentRepo.insertComment({
    threadId: id,
    userId,
    source: 'user',
    content,
  });
  const comment = toThreadComment(inserted, await authorsByIds([userId]));

  // Live append for every current viewer (owner + sharees) via the thread's
  // presence room. The client also refetches on panel open as a backstop.
  c.env?.browserEvents?.toThreadViewers(id, { type: THREAD_COMMENT_EVENT, threadId: id, comment });

  return c.json(comment, 201);
});

// DELETE /api/threads/:id/comments/:commentId
threadRoutes.delete('/:id/comments/:commentId', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  const deleted = await commentRepo.deleteComment(id, commentId);
  if (!deleted) return c.json({ error: 'Comment not found' }, 404);
  c.env?.browserEvents?.toThreadViewers(id, {
    type: THREAD_COMMENT_DELETED_EVENT,
    threadId: id,
    commentId,
  });
  return c.json({ ok: true });
});

// Thread sharing routes (`/:id/shares`, `/shared-with-me`) live in
// routes/thread-shares.ts and are mounted alongside this router in index.ts.

// ── Workflow event fan-out ───────────────────────────────
//
// A thread owner's process posts here when a pipeline step emits a
// generic message — `notify` actions, log lines, etc. The server
// persists the event as a thread:event in the DB and broadcasts the same
// envelope shape used by emitWorkflowEvent in the runtime, so existing
// client listeners work unchanged.
threadRoutes.post('/:id/workflow-event', requireThreadOwner, async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

  const parsed = await parseJsonBody(c, threadWorkflowEventBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;

  if (!isString(body.type) || !body.type) {
    return c.json({ error: 'Missing required string field "type"' }, 400);
  }
  // Constrain the event type to the workflow:* / pipeline:* namespaces so
  // a forwarded user can't synthesize unrelated events (eg. agent:result).
  if (!body.type.startsWith('workflow:') && !body.type.startsWith('pipeline:')) {
    return c.json({ error: 'type must start with "workflow:" or "pipeline:"' }, 400);
  }
  // SAFETY: the request body was parsed as JSON, so `data` is JSON; a
  // non-null object that is not an array is a JSON object.
  const data: JsonObject =
    isObject(body.data) && !Array.isArray(body.data) ? (body.data as JsonObject) : {};

  await threadEventRepo.saveThreadEvent(id, body.type, data);

  // Mirror broadcastThreadEvent shape from packages/runtime/src/services/workflow-event-helpers.ts
  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  c.env?.browserEvents?.toUser(userId, {
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

const createdThreadIdSchema = z.object({ id: z.string().min(1) });

/**
 * A created or forked thread, as the contract's `Thread`. The runner (or the
 * sandbox launcher) replies with its own insert payload — flags as 0/1,
 * template variables as JSON text — but it persisted the row through the data
 * channel before replying, so the server answers from its own DB instead.
 * If the row is somehow missing, the original payload goes out unchanged
 * rather than failing a creation that succeeded.
 */
async function createdThreadResponse(
  c: Context<ServerEnv>,
  created: RunnerJson | undefined,
  status: 201 | 202,
) {
  const parsed = createdThreadIdSchema.safeParse(created);
  const row = parsed.success ? await threadRepo.getThread(parsed.data.id) : undefined;
  if (!row) {
    log.warn('Created thread not found in the server DB; returning the runner payload', {
      namespace: 'threads',
      threadId: parsed.success ? parsed.data.id : undefined,
    });
    // Written as text: the runner's JSON goes back byte for byte, and Hono's
    // typed `c.json` cannot expand a recursive JSON type. No payload at all
    // (a sandbox thread whose row is missing) is an empty body, as `c.json` sent.
    return c.newResponse(JSON.stringify(created), status, {
      'Content-Type': 'application/json',
    });
  }
  return c.json(toThread(row) satisfies Thread, status);
}

/**
 * Shared HTTP adapter for both creation endpoints. It parses the body, runs the
 * `modules/threads` creation use case, and maps its result to the existing
 * HTTP contract.
 */
async function handleCreateThread(c: Context<ServerEnv>, intent: CreationIntent) {
  const parsed = await parseJsonBody(c, threadCreateBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  // SAFETY: the request body was parsed as JSON, so every field is JSON.
  const payload: CreationPayload = parsed.value as JsonObject;
  if (payload.runtime === 'sandbox') return handleCreateSandboxThread(c, payload);

  const createThread = composeCreateThread(c.env);
  // SAFETY: the org-field casts only hide that they may be null; the actor reaches
  // runnerActor (runner-adapters.ts), whose `?? null` accepts null and undefined alike.
  const result = await createThread({
    actor: {
      userId: authenticatedUserId(c.get('userId')),
      organizationId: c.get('organizationId') as string | undefined,
      role: c.get('userRole'),
      organizationName: c.get('organizationName') as string | undefined,
    },
    intent,
    payload,
  });
  if (result.isOk()) return createdThreadResponse(c, result.value.thread, 201);
  return creationFailureResponse(c, intent, result.error);
}

type CreateThreadResult = Awaited<ReturnType<ReturnType<typeof composeCreateThread>>>;
type CreateThreadFailure = CreateThreadResult extends Result<unknown, infer E> ? E : never;

/** Map a creation-use-case failure onto the existing HTTP contract. */
function creationFailureResponse(
  c: Context<ServerEnv>,
  intent: CreationIntent,
  failure: CreateThreadFailure,
) {
  switch (failure.kind) {
    case 'rejected':
      return failure.code === 'project-required'
        ? c.json({ error: failure.message }, 400)
        : c.json({ error: failure.message, code: failure.code }, 400);
    case 'no-runner':
      return c.json(runnerResolver.describeResolutionFailure(failure.reason), 502);
    case 'remote-error':
      // SAFETY: failure.status is the HTTP status the runner answered, relayed as is.
      return c.json({ error: failure.message }, failure.status as any);
    case 'creation-failed': {
      // SAFETY: only optional `message` / `stack` are read; a non-Error cause logs String(cause).
      const cause = failure.cause as Error;
      log.error('Failed to create thread on runner', {
        namespace: 'threads',
        error: cause?.message ?? String(cause),
        stack: cause?.stack,
        path: runnerPathFor(intent),
      });
      return c.json({ error: 'Thread creation failed' }, 502);
    }
  }
}

/** `runtime: 'sandbox'`: the server creates the thread and starts it in its own sandbox. */
async function handleCreateSandboxThread(c: Context<ServerEnv>, payload: CreationPayload) {
  const userId = c.get('userId');
  const result = await sandboxThreadLauncherFor(c.env ?? {}).create(userId, payload);
  return sandboxLaunchResponse(c, result, 201);
}

/** A sandbox launch's reply: the thread, or the refusal shown as is. */
function sandboxLaunchResponse(
  c: Context<ServerEnv>,
  result: Awaited<ReturnType<ReturnType<typeof sandboxThreadLauncherFor>['create']>>,
  okStatus: 201 | 202,
) {
  if (result.isErr()) {
    // The refusal explains what to fix (configure a sandbox, set FUNNY_PUBLIC_URL…):
    // show it to the user instead of the generic per-status text.
    const { message, code, status } = result.error;
    return c.json({ error: message, code, friendlyMessage: message }, status);
  }
  return createdThreadResponse(c, result.value.thread, okStatus);
}

// POST /api/threads — Create a new thread
threadRoutes.post('/', (c) => handleCreateThread(c, 'normal'));

// POST /api/threads/idle — Create an idle thread
threadRoutes.post('/idle', (c) => handleCreateThread(c, 'idle'));

// ── Agent operations (proxied to runner) ─────────────────────────

// Removed with the standalone thread scheduler; answer 404 here instead of
// letting the path fall through to the runner proxy.
threadRoutes.all('/:id/scheduler/*', refuseRetiredRoute);

/**
 * A follow-up the OWNER sent to an issue-factory thread may take its parked
 * run over (services/factory/factory-run-control.ts); a steer sharee's may not.
 * Noted only once the runner accepted it.
 */
export async function noteFactoryOwnerFollowUp(c: Context<ServerEnv>, next: Next) {
  await next();
  const thread: ServerEnv['Variables']['thread'] | undefined = c.get('thread');
  if (thread?.source === 'factory' && thread.userId === c.get('userId') && c.res.status < 400) {
    noteOwnerFollowUp(thread.id);
  }
}

// POST /api/threads/:id/message — send message to running agent.
// ALLOW-LISTED for steer sharees (thread-sharing-steer): owner OR a sharee
// whose grant level is `steer`. This is one of only two runner-bound actions a
// non-owner may reach; the gate runs BEFORE proxyToRunner so a `view` sharee /
// non-sharee gets 404 here instead of crossing runner isolation.
threadRoutes.post('/:id/message', requireThreadSteer, noteFactoryOwnerFollowUp, proxyToRunner);

// A follow-up on a sandbox thread whose setup failed: provision a new sandbox
// for it and start the agent there (thread-sandboxes). Owner only.
threadRoutes.post('/:id/sandbox-retry', requireThreadOwner, async (c) => {
  const userId = c.get('userId');
  const parsed = await parseJsonBody(c, retrySandboxThreadSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const result = await sandboxThreadLauncherFor(c.env ?? {}).retry(
    userId,
    c.req.param('id'),
    parsed.value,
  );
  return sandboxLaunchResponse(c, result, 202);
});

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

// POST /api/threads/:id/permission-requests/:requestId/respond — resolve one
// live ACP continuation. Owner-only because it authorizes execution on the
// runner and must never be available to a steering sharee.
threadRoutes.post('/:id/permission-requests/:requestId/respond', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/convert-to-worktree — convert local thread to worktree.
// Owner-only git operation.
threadRoutes.post('/:id/convert-to-worktree', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/recap — a short summary of the thread's activity since
// the owner last read it, generated on the OWNER's runner by their utility model
// (openspec thread-recap, D1). Owner-only, NOT on the steer allow-list: a
// sharee or a stranger gets 404 here and no runner is asked; for the owner the
// proxy certifies the owner's own runner (`withRunnerFor`, no delegation).
threadRoutes.post('/:id/recap', requireThreadOwner, proxyToRunner);

// ── Thread fork (proxied to runner, then registered locally) ─────

/** HTTP strings per fork variant. Everything else is shared. */
const FORK_FAILURE: Record<ForkVariant, { readonly message: string; readonly log: string }> = {
  fork: { message: 'Thread fork failed', log: 'Failed to fork thread on runner' },
  'fork-and-rewind': {
    message: 'Thread fork-and-rewind failed',
    log: 'Failed to fork-and-rewind thread on runner',
  },
};

/**
 * Shared HTTP adapter for `/:id/fork` and `/:id/fork-and-rewind`. It reads the
 * raw body, builds the actor from the session, runs the `modules/threads` fork
 * use case against the source thread `requireThreadOwner` loaded, and maps the
 * failure union to the existing HTTP contract of each variant.
 */
async function handleForkThread(c: Context<ServerEnv>, variant: ForkVariant) {
  const sourceThreadId = c.req.param('id');
  const source = c.get('thread');

  const failed = (cause: unknown) => {
    log.error(FORK_FAILURE[variant].log, {
      namespace: 'threads',
      sourceThreadId,
      // SAFETY: the optional chain reads `message` only; a non-Error cause logs undefined.
      error: (cause as Error)?.message,
    });
    return c.json({ error: FORK_FAILURE[variant].message }, 502);
  };

  // The body is forwarded to the runner unparsed. Reading it is a transport
  // concern, so it happens here (before resolution) rather than in the command.
  let body: string;
  try {
    body = await c.req.text();
  } catch (cause) {
    return failed(cause);
  }

  const forkThread = composeForkThread(c.env);
  // SAFETY: the org-field casts only hide that they may be null; the actor reaches
  // runnerActor (runner-adapters.ts), whose `?? null` accepts null and undefined alike.
  return withForkInputs(
    {
      userId: authenticatedUserId(c.get('userId')),
      organizationId: c.get('organizationId') as string | undefined,
      role: c.get('userRole'),
      organizationName: c.get('organizationName') as string | undefined,
    },
    { id: authorizedThreadId(source.id), projectId: source.projectId, ownerId: source.userId },
    async (actor, namedSource) => {
      const ownership = threadOwnedBy(actor, namedSource);
      if (!ownership) return c.json({ error: 'Thread not found' }, 404);
      const result = await forkThread({ actor, source: namedSource, ownership, variant, body });
      if (result.isOk()) return createdThreadResponse(c, result.value.thread, 201);

      const failure = result.error;
      switch (failure.kind) {
        case 'no-runner':
          return c.json(runnerResolver.describeResolutionFailure(failure.reason), 502);
        case 'remote-error':
          // SAFETY: failure.status is the HTTP status the runner answered, relayed as is.
          return c.json({ error: failure.message }, failure.status as any);
        case 'fork-failed':
          return failed(failure.cause);
      }
    },
  );
}

// POST /api/threads/:id/fork — fork conversation at a user message
threadRoutes.post('/:id/fork', requireThreadOwner, (c) => handleForkThread(c, 'fork'));

// POST /api/threads/:id/rewind — proxy to runner. Owner-only: mutates the
// owner's worktree. Not part of the steer allow-list.
threadRoutes.post('/:id/rewind', requireThreadOwner, proxyToRunner);

// POST /api/threads/:id/fork-and-rewind — fork conversation, then rewind code
threadRoutes.post('/:id/fork-and-rewind', requireThreadOwner, (c) =>
  handleForkThread(c, 'fork-and-rewind'),
);

// PATCH /api/threads/:id/tool-calls/:toolCallId — update tool call output.
// Owner-only: mutates agent execution state. Not part of the steer allow-list.
threadRoutes.patch('/:id/tool-calls/:toolCallId', requireThreadOwner, proxyToRunner);

// GET /api/threads/:id/events — served from server DB
threadRoutes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

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
  if (!content || !isString(content)) {
    return c.json({ error: 'content is required' }, 400);
  }
  const updated = await messageQueueRepo.update(messageId, id, content);
  const queuedCount = await messageQueueRepo.queueCount(id);
  return c.json({ ok: !!updated, queuedCount, message: updated });
});

// ── Delete thread ─────────────────────────────────────────────

threadRoutes.delete('/:id', requireThreadOwner, async (c) => {
  const threadId = c.req.param('id');
  const thread = c.get('thread');
  const query = threadDeleteQuery.safeParse(c.req.query());
  const deleteBranch = query.success && query.data.deleteBranch === 'true';

  // Read before the row goes: the runner cannot look a deleted thread up.
  const workspace = workspaceToRemoveOnDelete(thread);

  await threadRepo.deleteThread(threadId);
  forgetThreadOwnership(threadId);
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // A sandbox thread's machine goes with it (thread-sandboxes). Provider calls
  // take seconds, so the answer does not wait for them.
  void destroyThreadSandbox(threadId);

  // The thread's workspace on its runner, after the answer (track-funny-actions,
  // design D8): the owner's runner only; a runner that cannot be reached is
  // recorded as a failed cleanup. The worktree path comes from the row.
  const requests = c.env?.runnerRequests;
  if (requests) {
    const ports = { requests, presence: c.env?.runnerPresence };
    const ownerId = thread.userId;
    if (workspace) {
      void requestThreadWorkspaceCleanup(ports, {
        userId: ownerId,
        thread: workspace,
        deleteBranch,
        reason: 'thread-deleted',
      });
    } else if (removesScratchOnDelete(thread)) {
      void requestScratchCleanup(ports, { userId: ownerId, threadId });
    }
  }

  return c.json({ ok: true });
});
