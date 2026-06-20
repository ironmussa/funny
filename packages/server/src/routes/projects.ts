/**
 * Project + membership routes for the central server.
 *
 * Project CRUD (list, create, get, update, delete, reorder) is handled here
 * because these are server-only concerns (DB writes). Startup command CRUD
 * is also handled here (DB-backed). Filesystem/git operations
 * (branches, checkout-preflight, hooks, weave) and command execution
 * (start/stop/status) fall through to the catch-all proxy in index.ts
 * which forwards them to the runner.
 */

import { isAbsolute, resolve } from 'path';

import { validateProjectPathLexical } from '@funny/core/git/path-validation';
import { Hono } from 'hono';
import { z } from 'zod';

import type { ServerEnv } from '../lib/types.js';
import { proxyToRunner } from '../middleware/proxy.js';
import * as pm from '../services/project-manager.js';
import * as projectRepo from '../services/project-repository.js';
import { findAnyRunnerForUser } from '../services/runner-manager.js';
import * as cmdRepo from '../services/startup-commands-repository.js';
import { parseJsonBody } from '../validation/request.js';

export const projectRoutes = new Hono<ServerEnv>();

/** Roles a project admin may assign to a collaborator (owner = creator only). */
const ASSIGNABLE_PROJECT_ROLES = new Set(['viewer', 'member', 'admin']);

const createProjectBodySchema = z.object({
  name: z.string().min(1, 'name and path are required'),
  path: z.string().min(1, 'name and path are required'),
});

const updateProjectBodySchema = z.object({
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  followUpMode: z.string().optional(),
  defaultProvider: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultMode: z.string().nullable().optional(),
  defaultPermissionMode: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  urls: z.array(z.string()).nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  launcherUrl: z.string().nullable().optional(),
  defaultAgentTemplateId: z.string().nullable().optional(),
  closed: z.boolean().optional(),
  fastMode: z.boolean().optional(),
});

const reorderProjectsBodySchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1, 'projectIds must be a non-empty array'),
});

const addProjectMemberBodySchema = z.object({
  userId: z.string().min(1, 'Missing required field: userId'),
  role: z.string().optional(),
});

const localPathBodySchema = z.object({
  localPath: z.string().min(1, 'Missing required field: localPath'),
});

const projectCommandBodySchema = z.object({
  label: z.string().min(1, 'label and command are required'),
  command: z.string().min(1, 'label and command are required'),
  port: z.number().optional(),
  portEnvVar: z.string().optional(),
});

// ── Project CRUD ─────────────────────────────────────────

/** GET /api/projects — list projects for the current user */
projectRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const isPersonal = c.req.query('personal') === 'true';
  const queryOrgId = c.req.query('orgId');
  const sessionOrgId = c.get('organizationId');

  const orgId = isPersonal ? null : queryOrgId || sessionOrgId;

  if (orgId) {
    const teamProjects = await projectRepo.listProjectsByOrg(orgId);
    const organizationName = c.get('organizationName') || undefined;
    const sharedProjects = teamProjects.filter((p) => p.userId !== userId);
    const localPaths = await Promise.all(
      sharedProjects.map((p) => projectRepo.getMemberLocalPath(p.id, userId)),
    );
    const localPathByProject = new Map(sharedProjects.map((p, i) => [p.id, localPaths[i]]));

    const result = teamProjects.map((p) => {
      if (p.userId === userId) {
        return { ...p, isTeamProject: true as const, organizationName, role: 'owner' as const };
      }
      const lp = localPathByProject.get(p.id) ?? null;
      return {
        ...p,
        isTeamProject: true as const,
        organizationName,
        localPath: lp ?? undefined,
        needsSetup: !lp,
      };
    });
    return c.json(result);
  }

  const projects = await projectRepo.listProjects(userId);
  // Exclude projects that belong to any organization
  const orgProjectIds = await projectRepo.getOrgProjectIds();
  const personalProjects = (
    orgProjectIds.length > 0 ? projects.filter((p) => !orgProjectIds.includes(p.id)) : projects
  ).map((p) => ({ ...p, role: 'owner' as const }));

  // Collaborator model: also surface projects the user was added to directly
  // (project_members) but does not own. Each carries the member's own local
  // working path and role; `needsSetup` flags those that still require the
  // member to pick a local directory (and connect their own runner) before use.
  const ownedIds = new Set(personalProjects.map((p) => p.id));
  const memberProjects = await projectRepo.listMemberProjects(userId);
  const sharedProjects = memberProjects
    .filter((p) => p.userId !== userId && !ownedIds.has(p.id))
    .map(({ localPath, memberRole, ...p }) => ({
      ...p,
      isTeamProject: true as const,
      localPath: localPath ?? undefined,
      needsSetup: !localPath,
      role: (memberRole === 'admin' ? 'admin' : 'member') as 'admin' | 'member',
    }));

  return c.json([...personalProjects, ...sharedProjects]);
});

/** GET /api/projects/resolve — find project by URL pattern */
projectRoutes.get('/resolve', async (c) => {
  const userId = c.get('userId') as string;
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }

  const projects = await projectRepo.listProjects(userId);
  const matched = projects.find((p) => p.urls?.some((pattern) => url.startsWith(pattern)));

  if (matched) {
    return c.json({ project: matched, source: 'url_match' });
  }
  return c.json({ project: null, source: 'none' });
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
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  // Ownership check
  const project = await projectRepo.getProject(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    if (!orgId || !(await projectRepo.isProjectInOrg(id, orgId))) {
      return c.json({ error: 'Access denied' }, 403);
    }
  }

  const parsed = await parseJsonBody(c, updateProjectBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const result = await projectRepo.updateProject(id, parsed.value);

  if (result.isErr()) {
    const e = result.error;
    const status =
      e.type === 'CONFLICT'
        ? 409
        : e.type === 'NOT_FOUND'
          ? 404
          : e.type === 'BAD_REQUEST'
            ? 400
            : 500;
    return c.json({ error: e.message }, status);
  }

  return c.json(result.value);
});

/** DELETE /api/projects/:id — delete a project (owner only) */
projectRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;

  const project = await projectRepo.getProject(id);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  if (project.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  await projectRepo.deleteProject(id);
  return c.json({ ok: true });
});

/** PUT /api/projects/reorder — reorder projects */
projectRoutes.put('/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, reorderProjectsBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { projectIds } = parsed.value;

  const result = await projectRepo.reorderProjects(userId, projectIds);
  if (result.isErr()) {
    return c.json({ error: result.error.message }, 500);
  }
  return c.json({ ok: true });
});

// ── Membership ───────────────────────────────────────────

/**
 * True when the caller is a project admin: either the project owner
 * (`projects.userId`) or a member with the `admin` role. Owners created before
 * the member-seeding change may have no member row, so the ownership check is
 * authoritative on its own — this is what unblocks adding the *first*
 * collaborator (previously impossible: an empty member list 403'd everyone).
 *
 * Gates everything that mutates *shared* project config (members, startup
 * commands, …). Plain `member` collaborators can read but not edit.
 */
async function isProjectAdmin(projectId: string, userId: string): Promise<boolean> {
  const project = await projectRepo.getProject(projectId);
  if (project?.userId === userId) return true;
  const members = await pm.listMembers(projectId);
  const self = members.find((m) => m.userId === userId);
  return self?.role === 'admin';
}

/** List members of a project */
projectRoutes.get('/:id/members', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  const project = await projectRepo.getProject(projectId);
  const isOwner = project?.userId === userId;
  if (!isOwner && !(await pm.isProjectMember(projectId, userId))) {
    return c.json({ error: 'Not a member of this project' }, 403);
  }

  const members = await pm.listMembersWithUsers(projectId);
  return c.json({ members });
});

/** Add a member to a project */
projectRoutes.post('/:id/members', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  if (!(await isProjectAdmin(projectId, userId))) {
    return c.json({ error: 'Only project admins can add members' }, 403);
  }

  const parsed = await parseJsonBody(c, addProjectMemberBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  // Validate the role against the project-assignable set (unified-rbac-grants).
  // `owner` is the creator and is never assigned here.
  const role = body.role ?? 'member';
  if (!ASSIGNABLE_PROJECT_ROLES.has(role)) {
    return c.json({ error: `Invalid role: ${role}`, code: 'invalid-project-role' }, 400);
  }

  const member = await pm.addMember(projectId, body.userId, role);
  return c.json(member, 201);
});

/** Remove a member from a project */
projectRoutes.delete('/:id/members/:userId', async (c) => {
  const reqUserId = c.get('userId') as string;
  const projectId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  // Admins (or the owner) can remove anyone; members can remove themselves.
  if (reqUserId !== targetUserId && !(await isProjectAdmin(projectId, reqUserId))) {
    return c.json({ error: 'Only project admins can remove members' }, 403);
  }

  await pm.removeMember(projectId, targetUserId);
  return c.json({ ok: true });
});

/** Set local working directory for a shared project (with validation + upsert) */
projectRoutes.post('/:id/local-path', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');

  const parsed = await parseJsonBody(c, localPathBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  // Validate: must be an absolute path
  if (!isAbsolute(body.localPath)) {
    return c.json({ error: 'Path must be absolute' }, 400);
  }

  const resolvedPath = resolve(body.localPath);

  // NOTE: the path lives on the member's RUNNER, not on this server (server and
  // runner are always separate processes), so we can't `existsSync` it here —
  // that check always failed in team mode. Lexical validation only; the runner
  // surfaces a clear error if the path isn't a real git repo when it's used.
  await pm.setMemberLocalPath(projectId, userId, resolvedPath);
  return c.json({ ok: true });
});

// ── Startup Commands CRUD (DB-backed, handled by server) ──
//
// Security CR-6: each route below verifies that the caller can access the
// parent project (owner or org member). Mutations also scope the command-id
// lookup to the parent projectId so a guessed id from another project
// cannot be modified or deleted.

/** Returns true when the user owns the project or is a member of an org that owns it. */
async function userCanAccessProject(
  projectId: string,
  userId: string,
  orgId: string | null,
): Promise<boolean> {
  const project = await projectRepo.getProject(projectId);
  if (!project) return false;
  if (project.userId === userId) return true;
  // Collaborator model: a direct project member can access the project's
  // sub-resources (commands, hooks, …) even without an org.
  if (await pm.isProjectMember(projectId, userId)) return true;
  if (orgId && (await projectRepo.isProjectInOrg(projectId, orgId))) return true;
  return false;
}

/** GET /api/projects/:id/commands — list commands for a project */
projectRoutes.get('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? null;
  if (!(await userCanAccessProject(projectId, userId, orgId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const commands = await cmdRepo.listCommands(projectId);
  return c.json(commands);
});

/** POST /api/projects/:id/commands — create a new command (project admins only) */
projectRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? null;
  // Hide existence from callers with no access to the project (IDOR: a
  // cross-tenant user must not be able to tell the project even exists).
  if (!(await userCanAccessProject(projectId, userId, orgId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  if (!(await isProjectAdmin(projectId, userId))) {
    return c.json({ error: 'Only project admins can edit startup commands' }, 403);
  }
  const parsed = await parseJsonBody(c, projectCommandBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { label, command } = parsed.value;
  const entry = await cmdRepo.createCommand({ projectId, label, command });
  return c.json(entry, 201);
});

/** PUT /api/projects/:id/commands/:cmdId — update a command (project admins only) */
projectRoutes.put('/:id/commands/:cmdId', async (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? null;
  if (!(await userCanAccessProject(projectId, userId, orgId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  if (!(await isProjectAdmin(projectId, userId))) {
    return c.json({ error: 'Only project admins can edit startup commands' }, 403);
  }
  const parsed = await parseJsonBody(c, projectCommandBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { label, command, port, portEnvVar } = parsed.value;
  await cmdRepo.updateCommand(cmdId, projectId, { label, command, port, portEnvVar });
  return c.json({ ok: true });
});

/** DELETE /api/projects/:id/commands/:cmdId — delete a command (project admins only) */
projectRoutes.delete('/:id/commands/:cmdId', async (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId') ?? null;
  if (!(await userCanAccessProject(projectId, userId, orgId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  if (!(await isProjectAdmin(projectId, userId))) {
    return c.json({ error: 'Only project admins can edit startup commands' }, 403);
  }
  await cmdRepo.deleteCommand(cmdId, projectId);
  return c.json({ ok: true });
});
