/**
 * Design routes for the central server.
 *
 * DB CRUD (list, get, create, delete) is handled here; folder creation on disk
 * is done by the runtime. The logic lives in `trpc/ports/designs.ts`, shared
 * with the `designs` tRPC procedures (openspec adopt-trpc-browser-api).
 *
 * Two route groups are exported:
 * - designProjectRoutes: mounted under /api/projects (list/create designs under a project)
 * - designRoutes: mounted under /api/designs (operations by design ID)
 */

import { createDesignBody } from '@funny/shared/contracts/designs';
import { Hono, type Context } from 'hono';

import { requireProjectAccess } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';
import { designsPort as port } from '../trpc/ports/designs.js';
import { answerJson } from '../trpc/reply.js';
import { parseJsonBody } from '../validation/request.js';

const userIdOf = (c: Context<ServerEnv>) => c.get('userId') as string;

// ── Routes nested under /api/projects/:id/designs ───────────────

export const designProjectRoutes = new Hono<ServerEnv>();

// GET /api/projects/:id/designs — list designs for a project
designProjectRoutes.get('/:id/designs', requireProjectAccess('view'), (c) =>
  answerJson(c, port.list(userIdOf(c), c.req.param('id'))),
);

// POST /api/projects/:id/designs — create a new design row
designProjectRoutes.post('/:id/designs', requireProjectAccess('view'), async (c) => {
  const parsed = await parseJsonBody(c, createDesignBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.create(userIdOf(c), c.req.param('id'), parsed.value), 201);
});

// ── Routes at /api/designs/:id ──────────────────────────────────

export const designRoutes = new Hono<ServerEnv>();

/** The design's owner only: 404 when missing, 403 when someone else's. */
async function refusal(c: Context<ServerEnv>, id: string) {
  const refused = await port.authorizeAccess(userIdOf(c), id);
  return refused && c.json({ error: refused.message }, refused.status as 403 | 404);
}

// GET /api/designs/:id — get design details
designRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  return (await refusal(c, id)) ?? answerJson(c, port.get(userIdOf(c), id));
});

// DELETE /api/designs/:id — delete a design row (folder cleanup is best-effort and runtime-side)
designRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  return (await refusal(c, id)) ?? answerJson(c, port.remove(userIdOf(c), id));
});
