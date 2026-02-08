import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import { isGitRepoSync } from '../utils/git-v2.js';
import type { Project } from '@a-parallel/shared';

export function listProjects(): Project[] {
  return db.select().from(schema.projects).all();
}

export function getProject(id: string): Project | undefined {
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
}

export function createProject(name: string, path: string): Project {
  if (!isGitRepoSync(path)) {
    throw new Error(`Not a git repository: ${path}`);
  }

  const project: Project = {
    id: nanoid(),
    name,
    path,
    createdAt: new Date().toISOString(),
  };

  db.insert(schema.projects).values(project).run();
  return project;
}

export function deleteProject(id: string): void {
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
}
