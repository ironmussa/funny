/**
 * Project CRUD backed by the server's database.
 *
 * This handles the pure data operations for the runtime's project model
 * (local projects with git validation). The runtime's project-manager
 * adds filesystem/git validation on top of these operations.
 */

import { resolve, isAbsolute } from 'path';

import { isGitRepoSync, ensureWeaveConfigured } from '@funny/core/git';
import type { Project, FollowUpMode } from '@funny/shared';
import { badRequest, notFound, conflict, internal, type DomainError } from '@funny/shared/errors';
import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { eq, and, asc, inArray, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ok, err, type Result } from 'neverthrow';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';

type ProjectRow = typeof schema.projects.$inferSelect;

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
): Promise<Result<Project, DomainError>> {
  if (!isAbsolute(rawPath)) {
    return err(badRequest('Project path must be absolute'));
  }
  const path = resolve(rawPath);

  if (!isGitRepoSync(path)) {
    return err(badRequest(`Not a git repository: ${path}`));
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

  const existing = await dbAll(
    db.select().from(schema.projects).where(eq(schema.projects.userId, userId)),
  );

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

  if (fields.name !== undefined) {
    const existingName = await dbGet(
      db.select().from(schema.projects).where(eq(schema.projects.name, fields.name)),
    );
    if (existingName && existingName.id !== id) {
      return err(conflict(`A project with this name already exists: ${fields.name}`));
    }
  }

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
