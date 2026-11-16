/**
 * Sandbox provider connections (change thread-sandboxes).
 *
 *   GET    /api/infra/providers               — registered providers + capabilities
 *   GET    /api/infra/connections             — the caller's connections (no secrets)
 *   POST   /api/infra/connections             — validate + store a credential
 *   POST   /api/infra/connections/:id/test    — re-validate a stored credential
 *   PATCH  /api/infra/connections/:id         — rename a connection
 *   DELETE /api/infra/connections/:id
 *   GET    /api/infra/projects/:projectId/sandbox — the caller's sandbox for a project
 *   PUT    /api/infra/projects/:projectId/sandbox — set it (connection, size, default)
 *   DELETE /api/infra/projects/:projectId/sandbox — clear it
 *   POST   /api/infra/threads/:threadId/sandbox — provision the thread's sandbox (202, async)
 *   GET    /api/infra/threads/:threadId/sandbox — its lifecycle state
 */

import { productionSandboxProviders, type SandboxProviderRegistry } from '@funny/sandbox';
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
import { sandboxMachineRequestSchema } from '../services/thread-sandboxes/launch-request-schema.js';
import {
  createProjectSandboxSettingsService,
  type ProjectSandboxError,
} from '../services/thread-sandboxes/project-sandbox-settings.js';
import { prepareSandboxLaunch } from '../services/thread-sandboxes/sandbox-launch.js';
import { sqlThreadSandboxStore } from '../services/thread-sandboxes/thread-sandbox-store.js';

const provisionSchema = sandboxMachineRequestSchema;

/** The caller's thread with its project path, or null when it is not theirs. */
async function ownedThreadProject(userId: string, threadId: string) {
  const [row] = await db
    .select({ projectId: threads.projectId, projectPath: projects.path })
    .from(threads)
    .leftJoin(projects, eq(projects.id, threads.projectId))
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  return row ?? null;
}

const projectSandboxSchema = z
  .object({
    connectionId: z.string().min(1),
    sizeId: z.string().min(1).max(32).optional(),
    enabledByDefault: z.boolean(),
  })
  .strict();

function respondProjectSandbox(c: Context<ServerEnv>, error: ProjectSandboxError) {
  switch (error.kind) {
    case 'not-found':
      return c.json({ error: error.message, code: error.kind }, 404);
    case 'invalid-size':
      return c.json({ error: error.message, code: error.kind }, 400);
    case 'connection':
      return c.json({ error: error.message, code: error.kind }, 422);
    case 'storage':
      log.error('Project sandbox storage failure', {
        namespace: 'thread-sandboxes',
        error: error.message,
      });
      return c.json({ error: 'Internal error', code: error.kind }, 500);
  }
}

const renameConnectionSchema = z.object({ label: z.string().trim().min(1).max(120) }).strict();

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
  const projectSandboxes = createProjectSandboxSettingsService(connections);
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

  routes.patch('/connections/:id', async (c) => {
    const parsed = renameConnectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid name', code: 'invalid' }, 400);
    const result = await connections.rename(c.get('userId'), c.req.param('id'), parsed.data.label);
    return result.isOk() ? c.json(result.value) : respond(c, result.error);
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

  // ── Project sandboxes (change project-sandboxes) ────────

  routes.get('/projects/:projectId/sandbox', async (c) => {
    const result = await projectSandboxes.get(c.get('userId'), c.req.param('projectId'));
    return result.isOk()
      ? c.json({ settings: result.value })
      : respondProjectSandbox(c, result.error);
  });

  routes.put('/projects/:projectId/sandbox', async (c) => {
    const parsed = projectSandboxSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid project sandbox', code: 'invalid' }, 400);
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const result = await projectSandboxes.save(userId, projectId, parsed.data);
    if (result.isErr()) return respondProjectSandbox(c, result.error);
    audit({
      action: 'infra.project_sandbox_set',
      actorId: userId,
      detail: `Project ${projectId} sandbox set`,
      meta: { projectId, connectionId: result.value.connectionId, sizeId: result.value.sizeId },
    });
    return c.json({ settings: result.value });
  });

  routes.delete('/projects/:projectId/sandbox', async (c) => {
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const result = await projectSandboxes.clear(userId, projectId);
    if (result.isErr()) return respondProjectSandbox(c, result.error);
    audit({
      action: 'infra.project_sandbox_cleared',
      actorId: userId,
      detail: `Project ${projectId} sandbox cleared`,
      meta: { projectId },
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
