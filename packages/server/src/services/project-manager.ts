/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Project
 * @domain depends: Database, GitCore
 */

import { resolve, isAbsolute } from 'path';

import { isGitRepoSync, ensureWeaveConfigured } from '@funny/core/git';
import type { Project, FollowUpMode } from '@funny/shared';
import { badRequest, notFound, conflict, internal, type DomainError } from '@funny/shared/errors';
import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ok, err, type Result } from 'neverthrow';

import { db, schema, dbAll, dbGet, dbRun } from '../db/index.js';
import { createPipeline } from './pipeline-orchestrator.js';

type ProjectRow = typeof schema.projects.$inferSelect;

/** Convert DB row to Project, mapping nullable fields to optional. */
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
    ...rest
  } = row;
  return {
    ...rest,
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

/**
 * List projects. In local mode (userId='__local__'), returns all projects.
 * In multi mode, filters by userId.
 */
export async function listProjects(userId: string): Promise<Project[]> {
  if (userId === '__local__') {
    return (
      await dbAll(
        db
          .select()
          .from(schema.projects)
          .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt)),
      )
    ).map(toProject);
  }
  return (
    await dbAll(
      db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.userId, userId))
        .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt)),
    )
  ).map(toProject);
}

/**
 * List projects associated with an organization via the team_projects join table.
 */
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

export async function getProject(id: string): Promise<Project | undefined> {
  const row = await dbGet(db.select().from(schema.projects).where(eq(schema.projects.id, id)));
  return row ? toProject(row) : undefined;
}

export async function projectNameExists(name: string, userId: string): Promise<boolean> {
  const existing =
    userId === '__local__'
      ? await dbGet(db.select().from(schema.projects).where(eq(schema.projects.name, name)))
      : await dbGet(
          db
            .select()
            .from(schema.projects)
            .where(and(eq(schema.projects.name, name), eq(schema.projects.userId, userId))),
        );
  return !!existing;
}

export async function createProject(
  name: string,
  rawPath: string,
  userId: string,
): Promise<Result<Project, DomainError>> {
  if (!isAbsolute(rawPath)) {
    return err(badRequest('Project path must be absolute'));
  }
  const path = resolve(rawPath);

  if (!isGitRepoSync(path)) {
    return err(badRequest(`Not a git repository: ${path}`));
  }

  // Check for duplicate path (scoped to user in multi mode)
  const existingPath =
    userId === '__local__'
      ? await dbGet(db.select().from(schema.projects).where(eq(schema.projects.path, path)))
      : await dbGet(
          db
            .select()
            .from(schema.projects)
            .where(and(eq(schema.projects.path, path), eq(schema.projects.userId, userId))),
        );
  if (existingPath) {
    return err(conflict(`A project with this path already exists: ${path}`));
  }

  // Check for duplicate name (scoped to user in multi mode)
  const existingName =
    userId === '__local__'
      ? await dbGet(db.select().from(schema.projects).where(eq(schema.projects.name, name)))
      : await dbGet(
          db
            .select()
            .from(schema.projects)
            .where(and(eq(schema.projects.name, name), eq(schema.projects.userId, userId))),
        );
  if (existingName) {
    return err(conflict(`A project with this name already exists: ${name}`));
  }

  // Get existing project count to assign sortOrder
  const existing =
    userId === '__local__'
      ? await dbAll(db.select().from(schema.projects))
      : await dbAll(db.select().from(schema.projects).where(eq(schema.projects.userId, userId)));

  // Auto-assign a color from the palette, cycling based on existing project count
  const PALETTE = [
    '#7CB9E8', // pastel blue
    '#F4A4A4', // pastel red
    '#A8D5A2', // pastel green
    '#F9D98C', // pastel amber
    '#C3A6E0', // pastel violet
    '#F2A6C8', // pastel pink
    '#89D4CF', // pastel teal
    '#F9B97C', // pastel orange
  ];
  const autoColor = PALETTE[existing.length % PALETTE.length];

  const project: Project = {
    id: nanoid(),
    name,
    path,
    userId,
    color: autoColor,
    sortOrder: existing.length,
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

  // Auto-configure Weave semantic merge driver (fire-and-forget)
  void ensureWeaveConfigured(project.path);

  // Auto-create a default pipeline so review triggers on every commit
  void createPipeline({
    projectId: project.id,
    userId,
    name: 'Default Pipeline',
  });

  return ok(project);
}

export function renameProject(id: string, name: string): Promise<Result<Project, DomainError>> {
  return updateProject(id, { name });
}

export async function updateProject(
  id: string,
  fields: {
    name?: string;
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
  },
): Promise<Result<Project, DomainError>> {
  const project = await dbGet(db.select().from(schema.projects).where(eq(schema.projects.id, id)));
  if (!project) {
    return err(notFound('Project not found'));
  }

  // Validate name uniqueness if name is being updated
  if (fields.name !== undefined) {
    const existingName = await dbGet(
      db.select().from(schema.projects).where(eq(schema.projects.name, fields.name)),
    );
    if (existingName && existingName.id !== id) {
      return err(conflict(`A project with this name already exists: ${fields.name}`));
    }
  }

  // Build update object with only provided fields
  const updateData: Record<string, unknown> = {};
  if (fields.name !== undefined) updateData.name = fields.name;
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

  await dbRun(db.update(schema.projects).set(updateData).where(eq(schema.projects.id, id)));
  return ok(toProject({ ...project, ...updateData } as ProjectRow));
}

export async function deleteProject(id: string): Promise<void> {
  await dbRun(db.delete(schema.projects).where(eq(schema.projects.id, id)));
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
            .where(
              userId === '__local__'
                ? eq(schema.projects.id, projectIds[i])
                : and(eq(schema.projects.id, projectIds[i]), eq(schema.projects.userId, userId)),
            ),
        );
      }
    });
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to reorder projects: ${e}`));
  }
}
