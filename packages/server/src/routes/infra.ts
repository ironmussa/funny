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
import { threads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { issueThreadProvisionToken } from '../services/runner-provision-tokens.js';
import { sandboxRunnerIdForThread } from '../services/runner-scope.js';
import {
  createInfraConnectionService,
  type InfraConnectionError,
} from '../services/thread-sandboxes/infra-connections.js';
import { productionSandboxProviders } from '../services/thread-sandboxes/provider-catalog.js';
import { resolvePublicServerUrl } from '../services/thread-sandboxes/public-server-url.js';
import type { SandboxProviderRegistry } from '../services/thread-sandboxes/registry.js';
import { resolveRunnerBuild } from '../services/thread-sandboxes/runner-build.js';
import {
  createRunnerTemplateManager,
  type RunnerTemplateManager,
} from '../services/thread-sandboxes/template-manager.js';
import { createThreadSandboxService } from '../services/thread-sandboxes/thread-sandbox-service.js';
import { sqlThreadSandboxStore } from '../services/thread-sandboxes/thread-sandbox-store.js';

const provisionSchema = z
  .object({
    connectionId: z.string().min(1),
    sizeId: z.string().min(1).max(32).optional(),
  })
  .strict();

const ACTIVE_SANDBOX_STATES = new Set(['provisioning', 'installing', 'connecting', 'running']);

/** One template manager per server build, shared by every request. */
const templateManagers = new Map<string, RunnerTemplateManager>();

async function ownsThread(userId: string, threadId: string) {
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  return !!row;
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

    const build = resolveRunnerBuild();
    if (build.isErr()) return c.json({ error: build.error.message, code: build.error.kind }, 409);
    const serverUrl = resolvePublicServerUrl();
    if (serverUrl.isErr()) {
      return c.json({ error: serverUrl.error.message, code: serverUrl.error.kind }, 409);
    }
    if (!(await ownsThread(userId, threadId))) {
      return c.json({ error: 'Thread not found', code: 'not-found' }, 404);
    }
    const existing = await sqlThreadSandboxStore.get(threadId);
    if (existing.isOk() && existing.value && ACTIVE_SANDBOX_STATES.has(existing.value.state)) {
      return c.json(
        {
          error: `Thread already has a ${existing.value.state} sandbox`,
          code: 'already-provisioned',
        },
        409,
      );
    }

    let templates = templateManagers.get(build.value.version);
    if (!templates) {
      templates = createRunnerTemplateManager(build.value);
      templateManagers.set(build.value.version, templates);
    }
    const service = createThreadSandboxService({
      connections,
      templates,
      build: build.value,
      serverUrl: serverUrl.value,
      issueToken: issueThreadProvisionToken,
      sandboxRunnerIdForThread,
      presence: c.env?.runnerPresence,
      store: sqlThreadSandboxStore,
    });
    // Provisioning takes minutes: answer now, report progress via GET.
    void service.provision({ userId, threadId, ...parsed.data }).then((result) => {
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
