import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { resolve, isAbsolute } from 'path';
import { ok, err, type Result } from 'neverthrow';
import { db, schema } from '../db/index.js';
import { isGitRepoSync } from '../utils/git-v2.js';
import { badRequest, notFound, conflict, type DomainError } from '@a-parallel/shared/errors';
import type { Project } from '@a-parallel/shared';

export function listProjects(): Project[] {
  return db.select().from(schema.projects).all();
}

export function getProject(id: string): Project | undefined {
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
}

export function createProject(name: string, rawPath: string): Result<Project, DomainError> {
  if (!isAbsolute(rawPath)) {
    return err(badRequest('Project path must be absolute'));
  }
  const path = resolve(rawPath);

  if (!isGitRepoSync(path)) {
    return err(badRequest(`Not a git repository: ${path}`));
  }

  const existingPath = db.select().from(schema.projects).where(eq(schema.projects.path, path)).get();
  if (existingPath) {
    return err(conflict(`A project with this path already exists: ${path}`));
  }

  const existingName = db.select().from(schema.projects).where(eq(schema.projects.name, name)).get();
  if (existingName) {
    return err(conflict(`A project with this name already exists: ${name}`));
  }

  const project: Project = {
    id: nanoid(),
    name,
    path,
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
