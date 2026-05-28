/**
 * Project CRUD backed by the server's database.
 *
 * This handles the pure data operations for the runtime's project model
 * (local projects with git validation). The runtime's project-manager
 * adds filesystem/git validation on top of these operations.
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, resolve, isAbsolute, sep } from 'path';

import { isGitRepoSync, isGitRepoRootSync, ensureWeaveConfigured } from '@funny/core/git';
import type { Project, FollowUpMode } from '@funny/shared';
import { badRequest, notFound, conflict, internal, type DomainError } from '@funny/shared/errors';
import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { eq, and, asc, inArray, notInArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ok, err, type Result } from 'neverthrow';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';

type ProjectRow = typeof schema.projects.$inferSelect;

// ── Security HI-3: project-path sanity check ─────────────────
//
// `createProject` previously accepted any absolute path provided it was a
// git repo on the server's filesystem. On single-node deployments
// (server + runner on the same host — the default `bun run dev` setup) that
// let any authenticated user register `/var/lib/<service>/.git`, system
// repos, or another user's tree as their project. Once registered, the
// path becomes the trusted scope for `requireProjectPath`, granting
// file/index/search/agent-spawn access across the host.
//
// The defenses below are layered:
//   1. Reject traversal (`..`), leading-`-` (flag injection), and absolute
//      paths under known system directories regardless of platform.
//   2. When filesystem checks are enabled (single-node mode), realpath the
//      path and require it sits inside one of the caller-relevant homes —
//      either the OS user's `$HOME` (single-node) or a recorded org-server
//      data root via the `FUNNY_PROJECT_ROOT` env override (deployments
//      that genuinely need a wider scope can opt in explicitly).
//
// In team-mode (server and runner on different hosts) `isGitRepoSync` on
// the server is already false for the runner's paths, so the filesystem
// check naturally rejects them — the prefix block still catches the
// edge case of a server with `/var` etc. accessible.

/** Unix-style absolute paths that must never become a project root. */
const PROJECT_BLOCKED_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/boot',
  '/root',
  '/var',
  '/usr',
  '/lib',
  '/lib64',
  '/sbin',
  '/bin',
  '/srv',
  '/opt/funny', // app's own install dir; never register itself
];

/** Windows-style system roots that must never become a project root. */
const PROJECT_BLOCKED_WINDOWS_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
];

function projectPathRealpathOrAnchor(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.push(basename(current));
      current = parent;
    }
  }
  return resolve(target);
}

function isUnderPath(target: string, scope: string): boolean {
  const t = target;
  const s = resolve(scope);
  return t === s || t.startsWith(s + sep);
}

function isUnderPathCaseInsensitive(target: string, scope: string): boolean {
  const t = target.toLowerCase();
  const s = resolve(scope).toLowerCase();
  return t === s || t.startsWith(s + sep);
}

/**
 * Returns null when the path is acceptable as a project root, or a
 * DomainError describing why it was rejected. Pure function: only filesystem
 * read is `realpath`.
 */
function validateProjectPath(rawPath: string, skipFsCheck: boolean): DomainError | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return badRequest('Project path must be a non-empty string');
  }
  if (rawPath.startsWith('-')) {
    return badRequest('Project path must not start with "-"');
  }
  if (rawPath.includes('\0')) {
    return badRequest('Project path contains a null byte');
  }
  if (!isAbsolute(rawPath)) {
    return badRequest('Project path must be absolute');
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    return badRequest('Project path must not contain ".." segments');
  }

  const lexical = resolve(rawPath);

  // Cross-platform: reject Unix system prefixes regardless of platform.
  // (A server running on Linux must not register `/etc`; a Windows server
  // hitting `/etc` via an unusual layout still gets the wrong answer back.)
  for (const prefix of PROJECT_BLOCKED_PREFIXES) {
    if (lexical === prefix || lexical.startsWith(prefix + '/')) {
      return badRequest(`Project path is in a restricted system directory: ${prefix}`);
    }
  }
  for (const prefix of PROJECT_BLOCKED_WINDOWS_PREFIXES) {
    if (isUnderPathCaseInsensitive(lexical, prefix)) {
      return badRequest(`Project path is in a restricted system directory: ${prefix}`);
    }
  }

  if (skipFsCheck) return null;

  // Filesystem-aware checks (single-node deployments).
  const real = projectPathRealpathOrAnchor(rawPath);
  // Re-check prefixes against the realpath — a symlink at /home/user/sneaky
  // pointing to /etc would otherwise still slip through.
  for (const prefix of PROJECT_BLOCKED_PREFIXES) {
    if (real === prefix || real.startsWith(prefix + '/')) {
      return badRequest(`Project path resolves to a restricted system directory: ${prefix}`);
    }
  }
  for (const prefix of PROJECT_BLOCKED_WINDOWS_PREFIXES) {
    if (isUnderPathCaseInsensitive(real, prefix)) {
      return badRequest(`Project path resolves to a restricted system directory: ${prefix}`);
    }
  }

  // Containment to the OS user's $HOME (the realpath of $HOME), unless an
  // operator opts in to a wider root via FUNNY_PROJECT_ROOT (comma-sep list
  // of additional allowed roots — e.g. /workspaces for codespaces-style
  // deployments).
  const allowedRoots: string[] = [projectPathRealpathOrAnchor(homedir())];
  const extraRoots = process.env.FUNNY_PROJECT_ROOT;
  if (extraRoots) {
    for (const r of extraRoots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      allowedRoots.push(projectPathRealpathOrAnchor(r));
    }
  }
  const allowed = allowedRoots.some((root) => isUnderPath(real, root));
  if (!allowed) {
    return badRequest(
      `Project path must live under the server's $HOME (or a path in FUNNY_PROJECT_ROOT). Path resolves to: ${real}`,
    );
  }
  return null;
}

function toProject(row: ProjectRow): Project {
  const {
    color,
    followUpMode,
    defaultProvider,
    defaultModel,
    defaultMode,
    defaultPermissionMode,
    defaultBranch,
    urls: urlsRaw,
    systemPrompt,
    launcherUrl,
    closed,
    ...rest
  } = row as ProjectRow & { closed?: number | boolean | null };
  return {
    ...rest,
    ...(closed ? { closed: true } : {}),
    ...(color != null ? { color } : {}),
    ...(followUpMode && followUpMode !== DEFAULT_FOLLOW_UP_MODE
      ? { followUpMode: followUpMode as FollowUpMode }
      : {}),
    ...(defaultProvider != null
      ? { defaultProvider: defaultProvider as Project['defaultProvider'] }
      : {}),
    ...(defaultModel != null ? { defaultModel: defaultModel as Project['defaultModel'] } : {}),
    ...(defaultMode != null ? { defaultMode: defaultMode as Project['defaultMode'] } : {}),
    ...(defaultPermissionMode != null
      ? { defaultPermissionMode: defaultPermissionMode as Project['defaultPermissionMode'] }
      : {}),
    ...(defaultBranch != null ? { defaultBranch } : {}),
    ...(urlsRaw != null ? { urls: JSON.parse(urlsRaw) as string[] } : {}),
    ...(systemPrompt != null ? { systemPrompt } : {}),
    ...(launcherUrl != null ? { launcherUrl } : {}),
  };
}

export async function listProjects(userId: string): Promise<Project[]> {
  // Empty userId means "list all projects" (used by runner-internal services)
  const query = userId
    ? db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.userId, userId))
        .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt))
    : db
        .select()
        .from(schema.projects)
        .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt));
  return (await dbAll(query)).map(toProject);
}

export async function listProjectsByOrg(orgId: string): Promise<Project[]> {
  const teamProjectRows = await dbAll(
    db
      .select({ projectId: schema.teamProjects.projectId })
      .from(schema.teamProjects)
      .where(eq(schema.teamProjects.teamId, orgId)),
  );

  if (teamProjectRows.length === 0) return [];

  const projectIds = teamProjectRows.map((r: any) => r.projectId);
  return (
    await dbAll(
      db
        .select()
        .from(schema.projects)
        .where(inArray(schema.projects.id, projectIds))
        .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt)),
    )
  ).map(toProject);
}

export async function isProjectInOrg(projectId: string, orgId: string): Promise<boolean> {
  const row = await dbGet(
    db
      .select()
      .from(schema.teamProjects)
      .where(
        and(eq(schema.teamProjects.teamId, orgId), eq(schema.teamProjects.projectId, projectId)),
      ),
  );
  return !!row;
}

export async function getProject(id: string): Promise<Project | undefined> {
  const row = await dbGet(db.select().from(schema.projects).where(eq(schema.projects.id, id)));
  return row ? toProject(row) : undefined;
}

/** Return IDs of all projects associated with any organization. */
export async function getOrgProjectIds(): Promise<string[]> {
  const rows = await dbAll(
    db.select({ projectId: schema.teamProjects.projectId }).from(schema.teamProjects),
  );
  return rows.map((r: any) => r.projectId);
}

export async function projectNameExists(
  name: string,
  userId: string,
  orgId?: string | null,
): Promise<boolean> {
  if (orgId) {
    const orgProjects = await listProjectsByOrg(orgId);
    return orgProjects.some((p) => p.name === name);
  }

  // For personal projects, exclude projects that belong to any organization
  const orgIds = await getOrgProjectIds();
  const conditions = [eq(schema.projects.name, name), eq(schema.projects.userId, userId)];
  if (orgIds.length > 0) conditions.push(notInArray(schema.projects.id, orgIds));

  const existing = await dbGet(
    db
      .select()
      .from(schema.projects)
      .where(and(...conditions)),
  );
  return !!existing;
}

export async function createProject(
  name: string,
  rawPath: string,
  userId: string,
  orgId?: string | null,
  /** Skip filesystem checks (git repo validation). Use when the caller already verified the path (e.g. runner after clone). */
  skipFsCheck?: boolean,
): Promise<Result<Project, DomainError>> {
  // Security HI-3: layered path validation (see `validateProjectPath`).
  // Catches `/etc`, `/var/*`, Windows system dirs, symlink escapes from $HOME,
  // and leading-`-` flag-injection candidates before touching the filesystem.
  const pathErr = validateProjectPath(rawPath, skipFsCheck ?? false);
  if (pathErr) return err(pathErr);
  const path = resolve(rawPath);

  if (!skipFsCheck) {
    if (!isGitRepoSync(path)) {
      return err(badRequest(`Not a git repository: ${path}`));
    }
    if (!isGitRepoRootSync(path)) {
      return err(
        badRequest(
          `Path is nested inside another git repository (not the repo root): ${path}. Run "git init" in this directory, or pick the repo's actual root.`,
        ),
      );
    }
  }

  if (orgId) {
    const orgProjects = await listProjectsByOrg(orgId);
    if (orgProjects.some((p) => p.path === path)) {
      return err(conflict(`A project with this path already exists: ${path}`));
    }
    if (orgProjects.some((p) => p.name === name)) {
      return err(conflict(`A project with this name already exists: ${name}`));
    }
  } else {
    // For personal projects, exclude projects that belong to any organization
    const orgIds = await getOrgProjectIds();

    const pathConditions = [eq(schema.projects.path, path), eq(schema.projects.userId, userId)];
    if (orgIds.length > 0) pathConditions.push(notInArray(schema.projects.id, orgIds));

    const existingPath = await dbGet(
      db
        .select()
        .from(schema.projects)
        .where(and(...pathConditions)),
    );
    if (existingPath) {
      return err(conflict(`A project with this path already exists: ${path}`));
    }

    const nameConditions = [eq(schema.projects.name, name), eq(schema.projects.userId, userId)];
    if (orgIds.length > 0) nameConditions.push(notInArray(schema.projects.id, orgIds));

    const existingName = await dbGet(
      db
        .select()
        .from(schema.projects)
        .where(and(...nameConditions)),
    );
    if (existingName) {
      return err(conflict(`A project with this name already exists: ${name}`));
    }
  }

  const countResult = await dbGet(
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId)),
  );
  const projectCount = countResult?.count ?? 0;

  const PALETTE = [
    '#7CB9E8',
    '#F4A4A4',
    '#A8D5A2',
    '#F9D98C',
    '#C3A6E0',
    '#F2A6C8',
    '#89D4CF',
    '#F9B97C',
  ];
  const autoColor = PALETTE[projectCount % PALETTE.length];

  const project: Project = {
    id: nanoid(),
    name,
    path,
    userId,
    color: autoColor,
    sortOrder: projectCount,
    createdAt: new Date().toISOString(),
  };

  const projectRow: typeof schema.projects.$inferInsert = {
    id: project.id,
    name: project.name,
    path: project.path,
    color: project.color ?? null,
    userId: project.userId,
    sortOrder: project.sortOrder,
    createdAt: project.createdAt,
  };

  await dbRun(db.insert(schema.projects).values(projectRow));

  void ensureWeaveConfigured(project.path);

  // Auto-create a default pipeline
  const { createPipeline: createPipelineFn } = await import('./pipeline-repository.js');
  void createPipelineFn({
    projectId: project.id,
    userId,
    name: 'Default Pipeline',
  });

  return ok(project);
}

export async function updateProject(
  id: string,
  fields: {
    name?: string;
    path?: string;
    color?: string | null;
    followUpMode?: string;
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultMode?: string | null;
    defaultPermissionMode?: string | null;
    defaultBranch?: string | null;
    urls?: string[] | null;
    systemPrompt?: string | null;
    launcherUrl?: string | null;
    defaultAgentTemplateId?: string | null;
    closed?: boolean;
  },
): Promise<Result<Project, DomainError>> {
  const project = await dbGet(db.select().from(schema.projects).where(eq(schema.projects.id, id)));
  if (!project) {
    return err(notFound('Project not found'));
  }

  if (fields.name !== undefined) {
    const existingName = await dbGet(
      db.select().from(schema.projects).where(eq(schema.projects.name, fields.name)),
    );
    if (existingName && existingName.id !== id) {
      return err(conflict(`A project with this name already exists: ${fields.name}`));
    }
  }

  let resolvedPath: string | undefined;
  if (fields.path !== undefined) {
    // Security HI-3: mirror createProject's containment check on update too,
    // so a user can't bypass the rule by creating a benign project and then
    // PATCHing the path.
    const pathErr = validateProjectPath(fields.path, false);
    if (pathErr) return err(pathErr);
    resolvedPath = resolve(fields.path);
    if (!isGitRepoSync(resolvedPath)) {
      return err(badRequest(`Not a git repository: ${resolvedPath}`));
    }
    if (!isGitRepoRootSync(resolvedPath)) {
      return err(
        badRequest(
          `Path is nested inside another git repository (not the repo root): ${resolvedPath}. Run "git init" in this directory, or pick the repo's actual root.`,
        ),
      );
    }
    const existingPath = await dbGet(
      db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.path, resolvedPath), eq(schema.projects.userId, project.userId)),
        ),
    );
    if (existingPath && existingPath.id !== id) {
      return err(conflict(`A project with this path already exists: ${resolvedPath}`));
    }
  }

  const updateData: Record<string, unknown> = {};
  if (fields.name !== undefined) updateData.name = fields.name;
  if (resolvedPath !== undefined) updateData.path = resolvedPath;
  if (fields.color !== undefined) updateData.color = fields.color;
  if (fields.followUpMode !== undefined) updateData.followUpMode = fields.followUpMode;
  if (fields.defaultProvider !== undefined) updateData.defaultProvider = fields.defaultProvider;
  if (fields.defaultModel !== undefined) updateData.defaultModel = fields.defaultModel;
  if (fields.defaultMode !== undefined) updateData.defaultMode = fields.defaultMode;
  if (fields.defaultPermissionMode !== undefined)
    updateData.defaultPermissionMode = fields.defaultPermissionMode;
  if (fields.defaultBranch !== undefined) updateData.defaultBranch = fields.defaultBranch;
  if (fields.urls !== undefined) updateData.urls = fields.urls ? JSON.stringify(fields.urls) : null;
  if (fields.systemPrompt !== undefined) updateData.systemPrompt = fields.systemPrompt;
  if (fields.launcherUrl !== undefined) updateData.launcherUrl = fields.launcherUrl;
  if (fields.defaultAgentTemplateId !== undefined)
    updateData.defaultAgentTemplateId = fields.defaultAgentTemplateId;
  if (fields.closed !== undefined) updateData.closed = fields.closed ? 1 : 0;

  await dbRun(db.update(schema.projects).set(updateData).where(eq(schema.projects.id, id)));
  return ok(toProject({ ...project, ...updateData } as ProjectRow));
}

export async function addProjectToOrg(projectId: string, orgId: string): Promise<void> {
  await dbRun(
    db.insert(schema.teamProjects).values({
      teamId: orgId,
      projectId,
      createdAt: new Date().toISOString(),
    }),
  );
}

export async function deleteProject(id: string): Promise<void> {
  await dbRun(db.delete(schema.projects).where(eq(schema.projects.id, id)));
}

export async function getMemberLocalPath(
  projectId: string,
  userId: string,
): Promise<string | null> {
  const row = await dbGet(
    db
      .select({ localPath: schema.projectMembers.localPath })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
        ),
      ),
  );
  return (row as { localPath: string | null } | undefined)?.localPath ?? null;
}

export async function resolveProjectPath(
  projectId: string,
  userId: string,
): Promise<Result<string, DomainError>> {
  const project = await getProject(projectId);
  if (!project) return err(notFound('Project not found'));

  if (project.userId === userId) return ok(project.path);

  const localPath = await getMemberLocalPath(projectId, userId);
  if (!localPath) {
    return err(
      badRequest(
        'Local directory not configured. Please set your working directory for this project first.',
      ),
    );
  }

  return ok(localPath);
}

export async function reorderProjects(
  userId: string,
  projectIds: string[],
): Promise<Result<void, DomainError>> {
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < projectIds.length; i++) {
        await dbRun(
          tx
            .update(schema.projects)
            .set({ sortOrder: i })
            .where(and(eq(schema.projects.id, projectIds[i]), eq(schema.projects.userId, userId))),
        );
      }
    });
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to reorder projects: ${e}`));
  }
}

export function renameProject(id: string, name: string) {
  return updateProject(id, { name });
}
