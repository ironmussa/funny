/**
 * Sandbox provider connections (change thread-sandboxes).
 *
 *   GET    /api/infra/providers               — registered providers + capabilities
 *   GET    /api/infra/connections             — the caller's connections (no secrets)
 *   POST   /api/infra/connections             — validate + store a credential
 *   POST   /api/infra/connections/:id/test    — re-validate a stored credential
 *   DELETE /api/infra/connections/:id
 *   POST   /api/infra/threads/:threadId/sandbox — provision the thread's sandbox (202, async)
 *   GET    /api/infra/threads/:threadId/sandbox — its lifecycle state
 */

import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { db } from '../db/index.js';
import { projects, threads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import {
  createInfraConnectionService,
  type InfraConnectionError,
} from '../services/thread-sandboxes/infra-connections.js';
import { productionSandboxProviders } from '../services/thread-sandboxes/provider-catalog.js';
import type { SandboxProviderRegistry } from '../services/thread-sandboxes/registry.js';
import { prepareSandboxLaunch } from '../services/thread-sandboxes/sandbox-launch.js';
import { sqlThreadSandboxStore } from '../services/thread-sandboxes/thread-sandbox-store.js';

const provisionSchema = z
  .object({
    connectionId: z.string().min(1),
    sizeId: z.string().min(1).max(32).optional(),
    /** Repository to clone; defaults to the project's origin read from its runner. */
    repoUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();

/** The caller's thread with its project path, or null when it is not theirs. */
async function ownedThreadProject(userId: string, threadId: string) {
  const [row] = await db
    .select({ projectId: threads.projectId, projectPath: projects.path })
    .from(threads)
    .leftJoin(projects, eq(projects.id, threads.projectId))
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  return row ?? null;
}

const addConnectionSchema = z
  .object({
    provider: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(120),
    credential: z.string().min(1).max(4096),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function respond(c: Context<ServerEnv>, error: InfraConnectionError) {
  switch (error.kind) {
    case 'unknown-provider':
    case 'invalid-config':
      return c.json({ error: error.message, code: error.kind }, 400);
    case 'rejected':
      return c.json({ error: error.message, code: error.kind, cause: error.cause }, 422);
    case 'not-found':
      return c.json({ error: 'Connection not found', code: error.kind }, 404);
    case 'storage':
      log.error('Infra connection storage failure', {
        namespace: 'thread-sandboxes',
        error: error.message,
      });
      return c.json({ error: 'Internal error', code: error.kind }, 500);
  }
}

export function createInfraRoutes(registry: SandboxProviderRegistry) {
  const connections = createInfraConnectionService(registry);
  const routes = new Hono<ServerEnv>();

  routes.get('/providers', (c) => c.json({ providers: registry.list() }));

  routes.get('/connections', async (c) => {
    const result = await connections.list(c.get('userId'));
    return result.isOk() ? c.json({ connections: result.value }) : respond(c, result.error);
  });

  routes.post('/connections', async (c) => {
    const parsed = addConnectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid connection', code: 'invalid' }, 400);
    const userId = c.get('userId');
    const result = await connections.add(userId, parsed.data);
    if (result.isErr()) return respond(c, result.error);
    audit({
      action: 'infra.connection_added',
      actorId: userId,
      detail: `Sandbox provider connection "${result.value.label}" added`,
      meta: { connectionId: result.value.id, provider: result.value.provider },
    });
    return c.json(result.value, 201);
  });

  routes.post('/connections/:id/test', async (c) => {
    const result = await connections.test(c.get('userId'), c.req.param('id'));
    return result.isOk() ? c.json(result.value) : respond(c, result.error);
  });

  routes.delete('/connections/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const result = await connections.remove(userId, id);
    if (result.isErr()) return respond(c, result.error);
    audit({
      action: 'infra.connection_removed',
      actorId: userId,
      detail: 'Sandbox provider connection removed',
      meta: { connectionId: id },
    });
    return c.json({ ok: true });
  });

  // ── Thread sandboxes ────────────────────────────────────

  routes.get('/threads/:threadId/sandbox', async (c) => {
    const row = await sqlThreadSandboxStore.get(c.req.param('threadId'));
    if (row.isErr()) return respond(c, { kind: 'storage', message: row.error });
    if (!row.value || row.value.userId !== c.get('userId')) {
      return c.json({ error: 'No sandbox for this thread', code: 'not-found' }, 404);
    }
    return c.json(row.value);
  });

  routes.post('/threads/:threadId/sandbox', async (c) => {
    const parsed = provisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid request', code: 'invalid' }, 400);
    const userId = c.get('userId');
    const threadId = c.req.param('threadId');

    const thread = await ownedThreadProject(userId, threadId);
    if (!thread) return c.json({ error: 'Thread not found', code: 'not-found' }, 404);
    if (!thread.projectId || !thread.projectPath) {
      return c.json({ error: 'Scratch threads cannot run in a sandbox', code: 'scratch' }, 400);
    }
    const prepared = await prepareSandboxLaunch(
      {
        userId,
        threadId,
        projectId: thread.projectId,
        projectPath: thread.projectPath,
        connectionId: parsed.data.connectionId,
        sizeId: parsed.data.sizeId,
        repoUrl: parsed.data.repoUrl,
      },
      { connections, requests: c.env?.runnerRequests, presence: c.env?.runnerPresence },
    );
    if (prepared.isErr()) {
      return c.json({ error: prepared.error.message, code: prepared.error.code }, 409);
    }
    // Provisioning takes minutes: answer now, report progress via GET.
    void prepared.value.provision().then((result) => {
      if (result.isErr()) return;
      audit({
        action: 'infra.sandbox_provisioned',
        actorId: userId,
        detail: `Sandbox provisioned for thread ${threadId}`,
        meta: { threadId, runnerId: result.value.runnerId, provider: result.value.provider },
      });
    });
    return c.json({ threadId, state: 'provisioning' }, 202);
  });

  return routes;
}

/** Production routes over every registered provider. */
export function infraRoutes() {
  const registry = productionSandboxProviders();
  if (registry.isErr()) throw new Error(`sandbox provider registry: ${registry.error.kind}`);
  return createInfraRoutes(registry.value);
}
