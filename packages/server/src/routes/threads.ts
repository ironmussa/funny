/**
 * Thread routes for the central server.
 *
 * Data CRUD (list, get, update, delete) is handled natively using the server's DB.
 * Agent operations (create+start, stop, send message) are proxied to the runner.
 */

import type { CommentAuthor, Thread, ThreadComment } from '@funny/shared';
import { threadsContract as contract } from '@funny/shared/contracts/threads';
import { THREAD_COMMENT_EVENT, THREAD_COMMENT_DELETED_EVENT } from '@funny/shared/socket-events';
import { inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
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
  type ForkVariant,
} from '../modules/threads/index.js';
import { forgetThreadOwnership } from '../services/data-ownership.js';
import * as messageQueueRepo from '../services/message-queue-repository.js';
import {
  authorizedRunnerRequests,
  runnerActor,
  withRunnerFor,
} from '../services/runner-access/index.js';
import * as runnerResolver from '../services/runner-resolver.js';
import * as threadEventRepo from '../services/thread-event-repository.js';
import * as threadRegistry from '../services/thread-registry.js';
import { destroyThreadSandbox } from '../services/thread-sandboxes/sandbox-lifecycle.js';
import { sandboxThreadLauncherFor } from '../services/thread-sandboxes/sandbox-thread-wiring.js';
import { retrySandboxThreadSchema } from '../services/thread-sandboxes/sandbox-thread.js';
import { createThreadsPort } from '../trpc/ports/threads.js';
import { answer } from '../trpc/reply.js';
import { serveEndpoint } from '../validation/endpoint.js';
import { parseJsonBody } from '../validation/request.js';

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

const schedulerWorkflowEventBodySchema = z
  .object({
    event: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

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

// ── Server-answered reads and field updates ────────────────────
// The logic lives in `trpc/ports/threads.ts`, shared with the `threads` tRPC
// procedures (openspec adopt-trpc-browser-api); these routes stay for REST
// consumers outside the web client and for the scheduler (status / stage).
const threadsPort = (c: Context<ServerEnv>) => createThreadsPort(c.env?.browserEvents);

// GET /api/threads?projectId=xxx&includeArchived=true&limit=50&offset=0&isScratch=true
serveEndpoint(threadRoutes, contract.list, ({ userId, query }, c) =>
  answer(threadsPort(c).list({ userId, organizationId: c.get('organizationId') }, query)),
);

// GET /api/threads/scratch — list the current user's scratch threads
serveEndpoint(threadRoutes, contract.scratch, ({ userId, query }, c) =>
  answer(threadsPort(c).scratch(userId, query)),
);

// GET /api/threads/archived?page=1&limit=100&search=xxx
serveEndpoint(threadRoutes, contract.archived, ({ userId, query }, c) =>
  answer(threadsPort(c).archived(userId, query)),
);

// GET /api/threads/:id — get thread with messages
serveEndpoint(threadRoutes, contract.get, ({ userId, params, query }, c) =>
  answer(threadsPort(c).get(userId, params.id, query)),
);

// GET /api/threads/:id/messages?cursor=<ISO>&limit=50&direction=before|after
serveEndpoint(
  threadRoutes,
  contract.messages,
  ({ params, query }, c) => answer(threadsPort(c).messages(params.id, query)),
  { middleware: [requireThreadView] },
);

// GET /api/threads/:id/messages/search?q=xxx&limit=100
serveEndpoint(
  threadRoutes,
  contract.searchMessages,
  ({ params, query }, c) => answer(threadsPort(c).searchMessages(params.id, query)),
  { middleware: [requireThreadView] },
);

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

const ownerOnly = { middleware: [requireThreadOwner] };

// PATCH /api/threads/:id — update thread data
serveEndpoint(
  threadRoutes,
  contract.update,
  ({ userId, body }, c) => answer(threadsPort(c).update(userId, c.get('thread'), body)),
  ownerOnly,
);

// PATCH /api/threads/:id/permission-mode
serveEndpoint(
  threadRoutes,
  contract.setPermissionMode,
  ({ userId, params, body }, c) =>
    answer(threadsPort(c).setPermissionMode(userId, params.id, body.permissionMode)),
  ownerOnly,
);

// ── Lifecycle endpoints used by the YAML pipeline DSL ───────
//
// `set_status` / `set_stage` actions in `.funny/workflows/*.yaml` post to these
// routes (when the pipeline runs server-side, e.g. in the scheduler's tunnel
// adapter).
serveEndpoint(
  threadRoutes,
  contract.setStatus,
  ({ userId, params, body }, c) =>
    answer(threadsPort(c).setStatus(userId, params.id, body.value, body.reason)),
  ownerOnly,
);

serveEndpoint(
  threadRoutes,
  contract.setStage,
  ({ userId, body }, c) =>
    answer(threadsPort(c).setStage(userId, c.get('thread'), body.value, body.reason)),
  ownerOnly,
);

// ── Workflow event fan-out (scheduler-bound) ─────────────
//
// The (co-located) scheduler binary posts here when a pipeline step
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
async function createdThreadResponse(c: Context<ServerEnv>, created: unknown, status: 201 | 202) {
  const parsed = createdThreadIdSchema.safeParse(created);
  const row = parsed.success ? await threadRepo.getThread(parsed.data.id) : undefined;
  if (!row) {
    log.warn('Created thread not found in the server DB; returning the runner payload', {
      namespace: 'threads',
      threadId: parsed.success ? parsed.data.id : undefined,
    });
    return c.json(created as Record<string, unknown>, status);
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
  if (parsed.value.runtime === 'sandbox') return handleCreateSandboxThread(c, parsed.value);

  const createThread = composeCreateThread(c.env);
  const result = await createThread({
    actor: {
      userId: authenticatedUserId(c.get('userId') as string),
      organizationId: c.get('organizationId') as string | undefined,
      role: c.get('userRole') as string | undefined,
      organizationName: c.get('organizationName') as string | undefined,
    },
    intent,
    payload: parsed.value,
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
      return c.json({ error: failure.message }, failure.status as any);
    case 'creation-failed': {
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
async function handleCreateSandboxThread(c: Context<ServerEnv>, payload: Record<string, unknown>) {
  const userId = c.get('userId') as string;
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

// POST /api/threads/:id/scheduler/workflow-event — scheduler-bound
// Generic event fan-out for the standalone scheduler. Mirrors the
// in-process pipeline-adapter's `notify()` path: the scheduler pushes
// a workflow event here and the server relays it to the user's browser
// clients via Socket.IO.
threadRoutes.post('/:id/scheduler/workflow-event', async (c) => {
  const threadId = c.req.param('id');
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsed = await parseJsonBody(c, schedulerWorkflowEventBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  const event = body.event;
  if (typeof event !== 'string' || !event.startsWith('workflow:')) {
    return c.json({ error: 'event must be a string starting with "workflow:"' }, 400);
  }

  c.env?.browserEvents?.toUser(userId, {
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

// A follow-up on a sandbox thread whose setup failed: provision a new sandbox
// for it and start the agent there (thread-sandboxes). Owner only.
threadRoutes.post('/:id/sandbox-retry', requireThreadOwner, async (c) => {
  const userId = c.get('userId') as string;
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
  return withForkInputs(
    {
      userId: authenticatedUserId(c.get('userId') as string),
      organizationId: c.get('organizationId') as string | undefined,
      role: c.get('userRole') as string | undefined,
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
  forgetThreadOwnership(threadId);

  // Find which runner handles this thread and clean up there too
  const runnerInfo = await threadRegistry.getRunnerForThread(threadId, userId);

  // Unregister from central DB and cache
  await threadRegistry.unregisterThread(threadId);
  runnerResolver.uncacheThread(threadId);

  // Proxy the delete to the runner. The runner may have lost access to the
  // thread's project since (binding change), so this certifies ownership only.
  // A refused or offline runner is fine: the central DB is already clean.
  if (runnerInfo) {
    const thread = c.get('thread');
    await withRunnerFor(
      runnerActor({
        userId,
        role: c.get('userRole') as string | undefined,
        orgId: c.get('organizationId') as string | undefined,
        orgName: c.get('organizationName') as string | undefined,
      }),
      { kind: 'owned-runner', runnerId: runnerInfo.runnerId },
      c.env?.runnerPresence,
      (actor, runner, proof) =>
        authorizedRunnerRequests(c.env?.runnerRequests)
          .send(actor, runner, proof, {
            method: 'DELETE',
            path: `/api/threads/${threadId}`,
            headers: { 'Content-Type': 'application/json' },
          })
          .catch(() => undefined),
    ).catch(() => undefined);
    void thread;
  }

  // A sandbox thread's machine goes with it (thread-sandboxes). Provider calls
  // take seconds, so the answer does not wait for them.
  void destroyThreadSandbox(threadId);

  return c.json({ ok: true });
});

// GET /api/threads/search/content?q=xxx&projectId=xxx&caseSensitive=true
serveEndpoint(threadRoutes, contract.searchContent, ({ userId, query }, c) =>
  answer(threadsPort(c).searchContent(userId, query)),
);
