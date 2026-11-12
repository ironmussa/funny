/**
 * Project + membership routes for the central server.
 *
 * The operations the server answers itself (list, resolve, update, delete,
 * reorder, members, local path, startup command CRUD) delegate to the projects
 * port, which the `projects` tRPC router serves too. Creation is proxied to the
 * user's runner when one is connected. Filesystem/git operations (branches,
 * checkout-preflight, hooks, weave) and command execution (start/stop/status)
 * fall through to the catch-all proxy in index.ts which forwards them to the
 * runner.
 */

import { validateProjectPathLexical } from '@funny/core/git/path-validation';
import {
  addProjectMemberBody,
  listProjectsQuery,
  projectCommandBody,
  projectLocalPathBody,
  reorderProjectsBody,
  type ProjectCommandBody,
  updateProjectBody,
} from '@funny/shared/contracts/projects';
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
projectRoutes.get('/resolve', async (c) => {
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }
  return answerJson(c, portFor(c).resolve(c.get('userId') as string, url));
});

/** POST /api/projects — create a new project */
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

/** PATCH /api/projects/:id — update a project */
projectRoutes.patch('/:id', requireProjectAccess('manage'), async (c) => {
  const parsed = await parseJsonBody(c, updateProjectBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(
    c,
    portFor(c).update(c.get('userId') as string, c.req.param('id'), parsed.value),
  );
});

/** DELETE /api/projects/:id — delete a project (owner only) */
projectRoutes.delete('/:id', requireProjectAccess('delete'), (c) =>
  answerJson(c, portFor(c).remove(c.req.param('id'))),
);

/** PUT /api/projects/reorder — reorder projects */
projectRoutes.put('/reorder', async (c) => {
  const parsed = await parseJsonBody(c, reorderProjectsBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, portFor(c).reorder(c.get('userId') as string, parsed.value.projectIds));
});

// ── Membership ───────────────────────────────────────────

/** List members of a project */
projectRoutes.get('/:id/members', requireProjectAccess('view'), (c) =>
  answerJson(c, portFor(c).members(c.req.param('id'))),
);

/** Add a member to a project */
projectRoutes.post(
  '/:id/members',
  requireProjectAccess('manage', { forbidden: 'Only project admins can add members' }),
  async (c) => {
    const parsed = await parseJsonBody(c, addProjectMemberBody);
    if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
    const { userId, role } = parsed.value;
    return answerJson(c, portFor(c).addMember(c.req.param('id'), userId, role), 201);
  },
);

/** Remove a member from a project (admins remove anyone, members themselves) */
projectRoutes.delete('/:id/members/:userId', requireProjectAccess('view'), (c) =>
  answerJson(
    c,
    portFor(c).removeMember(c.get('userId') as string, c.req.param('id'), c.req.param('userId')),
  ),
);

/** Set local working directory for a shared project (with validation + upsert) */
projectRoutes.post('/:id/local-path', requireProjectAccess('view'), async (c) => {
  const parsed = await parseJsonBody(c, projectLocalPathBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(
    c,
    portFor(c).setLocalPath(c.get('userId') as string, c.req.param('id'), parsed.value.localPath),
  );
});

// ── Startup Commands CRUD (DB-backed, handled by server) ──
//
const COMMANDS_FORBIDDEN = 'Only project admins can edit startup commands';

// Security CR-6: reads need view access to the parent project, mutations need
// `manage`. Mutations also scope the command-id lookup to the parent projectId
// so a guessed id from another project cannot be modified or deleted.

/** GET /api/projects/:id/commands — list commands for a project */
projectRoutes.get('/:id/commands', requireProjectAccess('view'), (c) =>
  answerJson(c, portFor(c).commands(c.req.param('id'))),
);

const editCommands = requireProjectAccess('manage', { forbidden: COMMANDS_FORBIDDEN });

/** A command write: the validated body, or 400. */
const withCommandBody =
  <P extends string>(
    handle: (c: Context<ServerEnv, P>, body: ProjectCommandBody) => Promise<Response>,
  ) =>
  async (c: Context<ServerEnv, P>) => {
    const parsed = await parseJsonBody(c, projectCommandBody);
    if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
    return handle(c, parsed.value);
  };

/** POST /api/projects/:id/commands — create a new command (project admins only) */
projectRoutes.post(
  '/:id/commands',
  editCommands,
  withCommandBody((c, body) =>
    answerJson(c, portFor(c).createCommand(c.req.param('id'), body), 201),
  ),
);

/** PUT /api/projects/:id/commands/:cmdId — update a command (project admins only) */
projectRoutes.put(
  '/:id/commands/:cmdId',
  editCommands,
  withCommandBody((c, body) =>
    answerJson(c, portFor(c).updateCommand(c.req.param('id'), c.req.param('cmdId'), body)),
  ),
);

/** DELETE /api/projects/:id/commands/:cmdId — delete a command (project admins only) */
projectRoutes.delete('/:id/commands/:cmdId', editCommands, (c) =>
  answerJson(c, portFor(c).deleteCommand(c.req.param('id'), c.req.param('cmdId'))),
);
