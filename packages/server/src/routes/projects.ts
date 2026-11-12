/**
 * Project routes the central server still answers over REST.
 *
 * The web client reads and writes projects over the `projects` and
 * `projectRunners` tRPC routers (openspec adopt-trpc-browser-api). What stays
 * here has callers outside the web client (list, resolve, delete) or is
 * runner-proxied (create). Filesystem/git operations (branches,
 * checkout-preflight, hooks, config, weave) and command execution
 * (start/stop/status/metrics) fall through to the catch-all proxy, which
 * forwards them to the runner.
 *
 * The REST routes that only the web client used were removed. Their paths are
 * refused explicitly (`refuseRemovedRoute`), never left to fall through: the
 * runner answers some of them itself (startup command CRUD), and a request
 * that reached a runner would skip the server's `requireProjectAccess` check.
 */

import { validateProjectPathLexical } from '@funny/core/git/path-validation';
import { listProjectsQuery } from '@funny/shared/contracts/projects';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { requireProjectAccess } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as projectRepo from '../services/project-repository.js';
import { findAnyRunnerForUser } from '../services/runner-manager.js';
import { createProjectsPort } from '../trpc/ports/projects.js';
import { answerJson } from '../trpc/reply.js';
import { parseJsonBody, parseQuery, queryBoolean } from '../validation/request.js';

export const projectRoutes = new Hono<ServerEnv>();

const createProjectBodySchema = z.object({
  name: z.string().min(1, 'name and path are required'),
  path: z.string().min(1, 'name and path are required'),
});

/** The list's query string: `personal=true` / `false` as a boolean. */
const listProjectsQueryString = listProjectsQuery.extend({ personal: queryBoolean.optional() });

const portFor = (c: Context<ServerEnv>) => createProjectsPort(c.get('organizationName'));

// ── Project CRUD ─────────────────────────────────────────

/** GET /api/projects — list projects for the current user */
// Kept on REST: called by the Chrome extension (packages/chrome-extension), client-gpuix, the e2e fixtures and docs/guides/ingest-api.md.
projectRoutes.get('/', async (c) => {
  const query = parseQuery(c, listProjectsQueryString);
  if (query.isErr()) return c.json({ error: query.error.message }, 400);
  return answerJson(
    c,
    portFor(c).list(
      { userId: c.get('userId') as string, organizationId: c.get('organizationId') ?? null },
      query.value,
    ),
  );
});

/** GET /api/projects/resolve — find project by URL pattern */
// Kept on REST: called by the Chrome extension (packages/chrome-extension).
projectRoutes.get('/resolve', async (c) => {
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }
  return answerJson(c, portFor(c).resolve(c.get('userId') as string, url));
});

/** POST /api/projects — create a new project */
// Kept on REST: proxied to the user's runner when one is connected, so it is not on tRPC.
projectRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  const parsed = await parseJsonBody(c, createProjectBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { name, path } = parsed.value;

  // Lexical project-root guards are host-independent and must apply before
  // runner delegation. Filesystem containment still runs on the runner in
  // team mode, where the path actually exists.
  const lexical = validateProjectPathLexical(path);
  if (lexical.isErr()) return c.json({ error: lexical.error.message }, 400);

  // Team/remote-runner mode: the project path lives on the runner's host, not
  // the server's. The server cannot validate it (its $HOME and filesystem are
  // unrelated — the git-repo and $HOME-containment checks would always fail).
  // Delegate creation to the user's runner, which validates the path against
  // its own filesystem and persists back via the data channel (skipFsCheck).
  // Falls through to local creation when no runner is connected (single-node
  // deployments without a separate runner process, and tests).
  const runnerId = await findAnyRunnerForUser(userId);
  if (runnerId) {
    return proxyToRunner(c);
  }

  // Duplicate name check
  const nameExists = await projectRepo.projectNameExists(name, userId, orgId);
  if (nameExists) {
    return c.json({ error: `A project named "${name}" already exists` }, 409);
  }

  const result = await projectRepo.createProject(name, path, userId, orgId);

  if (result.isErr()) {
    const e = result.error;
    const status = e.type === 'CONFLICT' ? 409 : e.type === 'BAD_REQUEST' ? 400 : 500;
    return c.json({ error: e.message }, status);
  }

  // Associate with organization
  if (orgId) {
    await projectRepo.addProjectToOrg(result.value.id, orgId);
  }

  return c.json(result.value, 201);
});

/** DELETE /api/projects/:id — delete a project (owner only) */
// Kept on REST: called by the e2e fixtures and the soak script.
projectRoutes.delete('/:id', requireProjectAccess('delete'), (c) =>
  answerJson(c, portFor(c).remove(c.req.param('id'))),
);

// ── Removed routes: refused, never proxied ───────────────
//
// These answered the web client, which now uses the `projects` / `projectRunners`
// tRPC procedures. Without a server route the request would fall through to the
// runner proxy; the runtime answers startup command CRUD itself, so a member's
// request would reach the owner's runner without `requireProjectAccess`.

const refuseRemovedRoute = (c: Context<ServerEnv>) => c.json({ error: 'Not found' }, 404);

/** Method + path of every removed route, relative to `/api/projects`. */
export const REMOVED_PROJECT_ROUTES = [
  ['PATCH', '/:id'],
  ['PUT', '/reorder'],
  ['GET', '/:id/members'],
  ['POST', '/:id/members'],
  ['DELETE', '/:id/members/:userId'],
  ['POST', '/:id/local-path'],
  ['GET', '/:id/commands'],
  ['POST', '/:id/commands'],
  ['PUT', '/:id/commands/:cmdId'],
  ['DELETE', '/:id/commands/:cmdId'],
  ['GET', '/:id/runner-settings'],
  ['PUT', '/:id/runner-settings'],
  ['POST', '/:id/runner-grants/:runnerId'],
  ['DELETE', '/:id/runner-grants/:runnerId'],
  ['PUT', '/general-runner'],
] as const;

for (const [method, path] of REMOVED_PROJECT_ROUTES) {
  projectRoutes.on(method, path, refuseRemovedRoute);
}
