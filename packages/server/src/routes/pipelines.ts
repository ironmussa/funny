/**
 * Pipeline CRUD routes for the central server.
 *
 * All pipeline data operations are handled natively using the server's DB.
 * Pipeline execution (review/fix runs) remains on the runner.
 */

import { randomUUID } from 'crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import { pipelineApprovalStore } from '../services/pipeline-approval-store.js';
import * as pipelineRepo from '../services/pipeline-repository.js';
import { relayToUser } from '../services/ws-relay.js';
import { parseJsonBody } from '../validation/request.js';

export const pipelineRoutes = new Hono<ServerEnv>();

// ── Approval gates ────────────────────────────────────────────
//
// These MUST be declared before the `:id` routes below so that the literal
// `approvals` segment is matched as a path, not as an `:id` parameter.
//
// `respond` is dual-tracked: server store first (scheduler-originated),
// then proxied to the runner (in-process pipeline-adapter).

pipelineRoutes.post(
  '/approvals/:approvalId/respond',
  async (c, next) => {
    const approvalId = c.req.param('approvalId') as string;
    if (!pipelineApprovalStore.has(approvalId)) {
      return next(); // fall through to runner proxy
    }

    const userId = c.get('userId') as string | undefined;
    if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

    const parsed = await parseJsonBody(c, approvalRespondBodySchema);
    if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
    const body = parsed.value;
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return c.json({ error: 'decision must be "approve" or "reject"' }, 400);
    }
    if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 4000)) {
      return c.json({ error: 'text must be a string ≤ 4000 chars' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text : undefined;
    if (body.decision === 'reject' && !text?.trim()) {
      return c.json({ error: 'A rejection reason is required' }, 400);
    }

    const result = pipelineApprovalStore.respond(approvalId, userId, {
      decision: body.decision,
      text,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error === 'forbidden' ? 'Forbidden' : 'Approval not found' },
        result.error === 'forbidden' ? 403 : 404,
      );
    }
    return c.json({ ok: true });
  },
  proxyToRunner,
);

pipelineRoutes.get(
  '/approvals/pending',
  async (c, next) => {
    // Surface server-side pending approvals first; the runner proxy still
    // covers in-process ones. Combining lists is a future improvement.
    const userId = c.get('userId');
    if (!userId) return next();
    const local = pipelineApprovalStore
      .list()
      .filter((entry) => entry.userId === userId)
      .map(({ approvalId, gateId, threadId, requestedAt }) => ({
        approvalId,
        gateId,
        threadId,
        requestedAt,
      }));
    if (local.length > 0) return c.json({ pending: local });
    return next();
  },
  proxyToRunner,
);

// ── Scheduler-bound endpoints ──────────────────────────────
//
// Called by the (co-located) scheduler binary using the
// X-Scheduler-Auth header + X-Forwarded-User. Required for the
// standalone scheduler to push progress and request approvals
// without a database, as the in-process pipeline-adapter does today.

const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const approvalRespondBodySchema = z.object({
  decision: z.unknown().optional(),
  text: z.unknown().optional(),
});

const approvalRequestBodySchema = z.object({
  threadId: z.unknown().optional(),
  gateId: z.unknown().optional(),
  message: z.unknown().optional(),
  workflowId: z.unknown().optional(),
  captureResponse: z.unknown().optional(),
  timeoutMs: z.unknown().optional(),
});

const progressBodySchema = z.object({
  threadId: z.unknown().optional(),
  pipelineId: z.unknown().optional(),
  runId: z.unknown().optional(),
  workflowId: z.unknown().optional(),
  kind: z.unknown().optional(),
  stage: z.unknown().optional(),
  status: z.unknown().optional(),
  error: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

const pipelinePromptFields = {
  reviewerPrompt: z.string().optional(),
  correctorPrompt: z.string().optional(),
  precommitFixerPrompt: z.string().optional(),
  commitMessagePrompt: z.string().optional(),
  testFixerPrompt: z.string().optional(),
};

const pipelineSettingsFields = {
  reviewModel: z.string().optional(),
  fixModel: z.string().optional(),
  maxIterations: z.number().optional(),
  precommitFixEnabled: z.boolean().optional(),
  precommitFixModel: z.string().optional(),
  precommitFixMaxIterations: z.number().optional(),
  testEnabled: z.boolean().optional(),
  testCommand: z.string().optional(),
  testFixEnabled: z.boolean().optional(),
  testFixModel: z.string().optional(),
  testFixMaxIterations: z.number().optional(),
  ...pipelinePromptFields,
};

const createPipelineBodySchema = z
  .object({
    projectId: z.string().optional(),
    name: z.string().optional(),
    ...pipelineSettingsFields,
  })
  .passthrough();

const updatePipelineBodySchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    ...pipelineSettingsFields,
  })
  .passthrough();

// POST /api/pipelines/scheduler/approvals/request — long-poll
pipelineRoutes.post('/scheduler/approvals/request', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsed = await parseJsonBody(c, approvalRequestBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;
  if (typeof body.threadId !== 'string' || !body.threadId) {
    return c.json({ error: 'threadId is required' }, 400);
  }
  if (typeof body.gateId !== 'string' || !body.gateId) {
    return c.json({ error: 'gateId is required' }, 400);
  }
  if (typeof body.message !== 'string' || !body.message) {
    return c.json({ error: 'message is required' }, 400);
  }
  if (body.workflowId !== undefined && typeof body.workflowId !== 'string') {
    return c.json({ error: 'workflowId must be a string' }, 400);
  }
  if (body.captureResponse !== undefined && typeof body.captureResponse !== 'boolean') {
    return c.json({ error: 'captureResponse must be a boolean' }, 400);
  }
  if (
    body.timeoutMs !== undefined &&
    (typeof body.timeoutMs !== 'number' ||
      !Number.isInteger(body.timeoutMs) ||
      body.timeoutMs <= 0 ||
      body.timeoutMs > MAX_APPROVAL_TIMEOUT_MS)
  ) {
    return c.json(
      { error: `timeoutMs must be a positive integer ≤ ${MAX_APPROVAL_TIMEOUT_MS}` },
      400,
    );
  }

  const threadId = body.threadId;
  const gateId = body.gateId;
  const message = body.message;
  const workflowId = body.workflowId as string | undefined;
  const captureResponse = body.captureResponse as boolean | undefined;
  const timeoutMs = body.timeoutMs as number | undefined;
  const approvalId = randomUUID();
  const requestedAt = new Date().toISOString();
  const expiresAt = timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : undefined;

  relayToUser(userId, {
    type: 'pipeline:approval_requested',
    threadId,
    data: {
      approvalId,
      gateId,
      message,
      captureResponse: captureResponse ?? false,
      threadId,
      workflowId,
      requestedAt,
      expiresAt,
    },
  });

  let payload: { decision: 'approve' | 'reject'; text?: string };
  try {
    payload = await pipelineApprovalStore.register(
      approvalId,
      { threadId, userId, gateId, requestedAt },
      timeoutMs,
    );
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    relayToUser(userId, {
      type: 'pipeline:approval_resolved',
      threadId,
      data: { approvalId, gateId, threadId, decision: 'timeout', payload: errMessage },
    });
    const timedOut = !!timeoutMs && errMessage.includes('timed out');
    return c.json(
      { ok: false, decision: 'timeout', error: errMessage, approvalId },
      timedOut ? 408 : 500,
    );
  }

  relayToUser(userId, {
    type: 'pipeline:approval_resolved',
    threadId,
    data: {
      approvalId,
      gateId,
      threadId,
      decision: payload.decision,
      payload: payload.text,
    },
  });

  return c.json({ ok: true, approvalId, decision: payload.decision, text: payload.text });
});

// POST /api/pipelines/scheduler/progress — fan out step / completion events
//
// `kind: "step"` emits pipeline:stage_update; `kind: "completed"` emits pipeline:run_completed.
pipelineRoutes.post('/scheduler/progress', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const parsed = await parseJsonBody(c, progressBodySchema);
  if (parsed.isErr()) return c.json({ error: 'Invalid JSON body' }, 400);
  const body = parsed.value;
  if (typeof body.threadId !== 'string' || !body.threadId) {
    return c.json({ error: 'threadId is required' }, 400);
  }
  if (typeof body.runId !== 'string' || !body.runId) {
    return c.json({ error: 'runId is required' }, 400);
  }
  if (body.kind !== 'step' && body.kind !== 'completed') {
    return c.json({ error: 'kind must be "step" or "completed"' }, 400);
  }
  for (const f of ['pipelineId', 'workflowId', 'stage', 'status', 'error'] as const) {
    if (body[f] !== undefined && typeof body[f] !== 'string') {
      return c.json({ error: `${f} must be a string` }, 400);
    }
  }
  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
  ) {
    return c.json({ error: 'metadata must be an object' }, 400);
  }

  const threadId = body.threadId;
  const pipelineId = body.pipelineId as string | undefined;
  const runId = body.runId;
  const kind = body.kind;
  const stage = body.stage as string | undefined;
  const status = body.status as string | undefined;
  const error = body.error as string | undefined;
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const eventType = kind === 'completed' ? 'pipeline:run_completed' : 'pipeline:stage_update';

  relayToUser(userId, {
    type: eventType,
    threadId,
    data: {
      pipelineId,
      runId,
      threadId,
      stage,
      status,
      error,
      ...(metadata ?? {}),
    },
  });

  log.debug('Scheduler progress relayed', {
    namespace: 'pipeline-routes',
    userId,
    threadId,
    runId,
    kind,
    stage,
    status,
  });

  return c.json({ ok: true });
});

// GET /api/pipelines/project/:projectId
pipelineRoutes.get('/project/:projectId', async (c) => {
  const userId = c.get('userId') as string;
  const { projectId } = c.req.param();
  // Security CR-5: scope to caller's pipelines so cross-tenant rows are
  // filtered server-side rather than relying on the project belonging to
  // the user (project ownership is enforced separately).
  const rows = await pipelineRepo.getPipelinesByProject(projectId, userId);
  return c.json(rows);
});

// GET /api/pipelines/:id
pipelineRoutes.get('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const { id } = c.req.param();
  const pipeline = await pipelineRepo.getPipelineById(id, userId);
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);
  return c.json(pipeline);
});

// POST /api/pipelines
pipelineRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, createPipelineBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  if (!body.projectId || !body.name) {
    return c.json({ error: 'projectId and name are required' }, 400);
  }

  const id = await pipelineRepo.createPipeline({
    projectId: body.projectId,
    userId,
    name: body.name,
    reviewModel: body.reviewModel,
    fixModel: body.fixModel,
    maxIterations: body.maxIterations,
    precommitFixEnabled: body.precommitFixEnabled,
    precommitFixModel: body.precommitFixModel,
    precommitFixMaxIterations: body.precommitFixMaxIterations,
    reviewerPrompt: body.reviewerPrompt,
    correctorPrompt: body.correctorPrompt,
    precommitFixerPrompt: body.precommitFixerPrompt,
    commitMessagePrompt: body.commitMessagePrompt,
    testEnabled: body.testEnabled,
    testCommand: body.testCommand,
    testFixEnabled: body.testFixEnabled,
    testFixModel: body.testFixModel,
    testFixMaxIterations: body.testFixMaxIterations,
    testFixerPrompt: body.testFixerPrompt,
  });

  const pipeline = await pipelineRepo.getPipelineById(id, userId);
  return c.json(pipeline, 201);
});

// PATCH /api/pipelines/:id
pipelineRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const { id } = c.req.param();
  const parsed = await parseJsonBody(c, updatePipelineBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  const existing = await pipelineRepo.getPipelineById(id, userId);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
  if (body.reviewModel !== undefined) updates.reviewModel = body.reviewModel;
  if (body.fixModel !== undefined) updates.fixModel = body.fixModel;
  if (body.maxIterations !== undefined) updates.maxIterations = body.maxIterations;
  if (body.precommitFixEnabled !== undefined)
    updates.precommitFixEnabled = body.precommitFixEnabled ? 1 : 0;
  if (body.precommitFixModel !== undefined) updates.precommitFixModel = body.precommitFixModel;
  if (body.precommitFixMaxIterations !== undefined)
    updates.precommitFixMaxIterations = body.precommitFixMaxIterations;
  if (body.reviewerPrompt !== undefined) updates.reviewerPrompt = body.reviewerPrompt || null;
  if (body.correctorPrompt !== undefined) updates.correctorPrompt = body.correctorPrompt || null;
  if (body.precommitFixerPrompt !== undefined)
    updates.precommitFixerPrompt = body.precommitFixerPrompt || null;
  if (body.commitMessagePrompt !== undefined)
    updates.commitMessagePrompt = body.commitMessagePrompt || null;
  if (body.testEnabled !== undefined) updates.testEnabled = body.testEnabled ? 1 : 0;
  if (body.testCommand !== undefined) updates.testCommand = body.testCommand || null;
  if (body.testFixEnabled !== undefined) updates.testFixEnabled = body.testFixEnabled ? 1 : 0;
  if (body.testFixModel !== undefined) updates.testFixModel = body.testFixModel;
  if (body.testFixMaxIterations !== undefined)
    updates.testFixMaxIterations = body.testFixMaxIterations;
  if (body.testFixerPrompt !== undefined) updates.testFixerPrompt = body.testFixerPrompt || null;

  await pipelineRepo.updatePipeline(id, userId, updates);
  return c.json(await pipelineRepo.getPipelineById(id, userId));
});

// DELETE /api/pipelines/:id
pipelineRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId') as string;
  const { id } = c.req.param();
  const existing = await pipelineRepo.getPipelineById(id, userId);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  await pipelineRepo.deletePipeline(id, userId);
  return c.json({ ok: true });
});

// GET /api/pipelines/runs/thread/:threadId
pipelineRoutes.get('/runs/thread/:threadId', async (c) => {
  const userId = c.get('userId') as string;
  const { threadId } = c.req.param();
  // Security CR-5: getRunsForThread verifies thread ownership internally and
  // returns [] for cross-tenant lookups.
  const runs = await pipelineRepo.getRunsForThread(threadId, userId);
  return c.json(runs);
});
