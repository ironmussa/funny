import { eq, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { resolve, isAbsolute } from 'path';
import { ok, err, type Result } from 'neverthrow';
import { db, schema } from '../db/index.js';
import { isGitRepoSync } from '../utils/git-v2.js';
import { badRequest, notFound, conflict, internal, type DomainError } from '@a-parallel/shared/errors';
import type { Project } from '@a-parallel/shared';

/**
 * List projects. In local mode (userId='__local__'), returns all projects.
 * In multi mode, filters by userId.
 */
export function listProjects(userId: string): Project[] {
  if (userId === '__local__') {
    return db.select().from(schema.projects)
      .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt))
      .all();
  }
  return db.select().from(schema.projects)
    .where(eq(schema.projects.userId, userId))
    .orderBy(asc(schema.projects.sortOrder), asc(schema.projects.createdAt))
    .all();
}

export function getProject(id: string): Project | undefined {
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
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
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) {
    return err(notFound('Project not found'));
  }

  const existingName = db.select().from(schema.projects).where(eq(schema.projects.name, name)).get();
  if (existingName && existingName.id !== id) {
    return err(conflict(`A project with this name already exists: ${name}`));
  }

  db.update(schema.projects).set({ name }).where(eq(schema.projects.id, id)).run();
  return ok({ ...project, name });
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
