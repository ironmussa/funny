import { eq, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { resolve, isAbsolute } from 'path';
import { ok, err, type Result } from 'neverthrow';
import { db, schema } from '../db/index.js';
import { isGitRepoSync } from '@funny/core/git';
import { badRequest, notFound, conflict, internal, type DomainError } from '@funny/shared/errors';
import type { Project } from '@funny/shared';

type ProjectRow = typeof schema.projects.$inferSelect;

/** Convert DB row (color: string | null) to Project (color?: string). */
function toProject(row: ProjectRow): Project {
  const { color, ...rest } = row;
  return color != null ? { ...rest, color } : rest;
}

/**
 * List projects. In local mode (userId='__local__'), returns all projects.
 * In multi mode, filters by userId.
 */
export function listProjects(userId: string): Project[] {
  if (userId === '__local__') {
    return db.select().from(schema.projects)
      .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt))
      .all().map(toProject);
  }
  return db.select().from(schema.projects)
    .where(eq(schema.projects.userId, userId))
    .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt))
    .all().map(toProject);
}

export function getProject(id: string): Project | undefined {
  const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  return row ? toProject(row) : undefined;
}

export function createProject(name: string, rawPath: string, userId: string): Result<Project, DomainError> {
  if (!isAbsolute(rawPath)) {
    return err(badRequest('Project path must be absolute'));
  }
  const path = resolve(rawPath);

  if (!isGitRepoSync(path)) {
    return err(badRequest(`Not a git repository: ${path}`));
  }

  // Check for duplicate path (scoped to user in multi mode)
  const existingPath = userId === '__local__'
    ? db.select().from(schema.projects).where(eq(schema.projects.path, path)).get()
    : db.select().from(schema.projects).where(and(eq(schema.projects.path, path), eq(schema.projects.userId, userId))).get();
  if (existingPath) {
    return err(conflict(`A project with this path already exists: ${path}`));
  }

  // Check for duplicate name (scoped to user in multi mode)
  const existingName = userId === '__local__'
    ? db.select().from(schema.projects).where(eq(schema.projects.name, name)).get()
    : db.select().from(schema.projects).where(and(eq(schema.projects.name, name), eq(schema.projects.userId, userId))).get();
  if (existingName) {
    return err(conflict(`A project with this name already exists: ${name}`));
  }

  // Get existing project count to assign sortOrder
  const existing = userId === '__local__'
    ? db.select().from(schema.projects).all()
    : db.select().from(schema.projects).where(eq(schema.projects.userId, userId)).all();

  const project: Project = {
    id: nanoid(),
    name,
    path,
    userId,
    sortOrder: existing.length,
    createdAt: new Date().toISOString(),
  };

  db.insert(schema.projects).values(project).run();
  return ok(project);
}

export function renameProject(id: string, name: string): Result<Project, DomainError> {
  return updateProject(id, { name });
}

export function updateProject(id: string, fields: { name?: string; color?: string | null }): Result<Project, DomainError> {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) {
    return err(notFound('Project not found'));
  }

  // Validate name uniqueness if name is being updated
  if (fields.name !== undefined) {
    const existingName = db.select().from(schema.projects).where(eq(schema.projects.name, fields.name)).get();
    if (existingName && existingName.id !== id) {
      return err(conflict(`A project with this name already exists: ${fields.name}`));
    }
  }

  // Build update object with only provided fields
  const updateData: Record<string, unknown> = {};
  if (fields.name !== undefined) updateData.name = fields.name;
  if (fields.color !== undefined) updateData.color = fields.color;

  db.update(schema.projects).set(updateData).where(eq(schema.projects.id, id)).run();
  return ok(toProject({ ...project, ...updateData } as ProjectRow));
}

export function deleteProject(id: string): void {
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
}

export function reorderProjects(userId: string, projectIds: string[]): Result<void, DomainError> {
  try {
    db.transaction((tx) => {
      for (let i = 0; i < projectIds.length; i++) {
        tx.update(schema.projects)
          .set({ sortOrder: i })
          .where(
            userId === '__local__'
              ? eq(schema.projects.id, projectIds[i])
              : and(eq(schema.projects.id, projectIds[i]), eq(schema.projects.userId, userId))
          )
          .run();
      }
    });
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to reorder projects: ${e}`));
  }
}
