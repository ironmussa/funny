/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: route
 * @domain layer: presentation
 *
 * User-facing orchestrator routes. Tenant-scoped — only the calling
 * user's runs are returned.
 *
 * Note: the orchestrator brain runs as a standalone process now (the
 * `@funny/thread-orchestrator` binary), not in-process. The `/runs`
 * endpoint reads directly from `orchestrator_runs`, which both the
 * standalone brain and the server share. The legacy `/refresh` endpoint
 * is a no-op for backwards compatibility — the standalone brain polls
 * automatically every `ORCHESTRATOR_POLL_MS`.
 */

import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { createOrchestratorRunRepository } from '@funny/shared/repositories';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';

export const orchestratorRoutes = new Hono<ServerEnv>();

const runRepo = createOrchestratorRunRepository({
  db,
  schema: schema as unknown as Parameters<typeof createOrchestratorRunRepository>[0]['schema'],
  dbAll,
  dbGet,
  dbRun,
});

/**
 * GET /api/orchestrator/runs — list active runs owned by the caller.
 */
orchestratorRoutes.get('/runs', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);

  const rows = await runRepo.listActiveRunsByUser(userId);
  return c.json({ runs: rows });
});

/**
 * POST /api/orchestrator/refresh — kept as a no-op for backwards
 * compatibility with older clients. The standalone brain polls on its
 * own schedule (default 5s) so manual ticks are no longer required nor
 * possible from this process.
 */
orchestratorRoutes.post('/refresh', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({
    summary: null,
    deprecated:
      'Manual refresh is no longer supported — the standalone orchestrator polls automatically.',
  });
});
