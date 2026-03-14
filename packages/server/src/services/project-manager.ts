/**
 * Project management service for the central server.
 * Source of truth for team projects and memberships.
 */

import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { projects, projectMembers } from '../db/schema.js';
import { log } from '../lib/logger.js';

// ── Types ────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  repoUrl: string;
  description?: string;
  organizationId?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  createdBy: string;
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: string;
  localPath: string | null;
  joinedAt: string;
}

// ── Project CRUD ─────────────────────────────────────────

export async function createProject(
  userId: string,
  input: CreateProjectInput,
): Promise<ProjectInfo> {
  const id = nanoid();
  const now = new Date().toISOString();

  const project: typeof projects.$inferInsert = {
    id,
    name: input.name,
    repoUrl: input.repoUrl,
    description: input.description ?? null,
    createdBy: userId,
    organizationId: input.organizationId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(project);

  // Auto-add creator as admin member
  await db.insert(projectMembers).values({
    projectId: id,
    userId,
    role: 'admin',
    joinedAt: now,
  });

  log.info('Project created', { namespace: 'project', projectId: id, name: input.name });

  return {
    id,
    name: input.name,
    repoUrl: input.repoUrl,
    description: input.description ?? null,
    createdBy: userId,
    organizationId: input.organizationId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getProject(projectId: string): Promise<ProjectInfo | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, projectId));
  return rows[0] as ProjectInfo | undefined;
}

export async function listProjectsForUser(userId: string): Promise<ProjectInfo[]> {
  const memberRows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));

  if (memberRows.length === 0) return [];

  const projectIds = memberRows.map((r) => r.projectId);
  const allProjects = await db.select().from(projects);
  return allProjects.filter((p) => projectIds.includes(p.id)) as ProjectInfo[];
}

export async function updateProject(
  projectId: string,
  updates: Partial<Pick<ProjectInfo, 'name' | 'repoUrl' | 'description'>>,
): Promise<ProjectInfo | undefined> {
  const now = new Date().toISOString();
  await db
    .update(projects)
    .set({ ...updates, updatedAt: now })
    .where(eq(projects.id, projectId));
  return getProject(projectId);
}

export async function deleteProject(projectId: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, projectId));
  log.info('Project deleted', { namespace: 'project', projectId });
}

// ── Membership ───────────────────────────────────────────

export async function addMember(
  projectId: string,
  userId: string,
  role: string = 'member',
): Promise<ProjectMember> {
  const now = new Date().toISOString();

  // Upsert
  try {
    await db.insert(projectMembers).values({
      projectId,
      userId,
      role,
      joinedAt: now,
    });
  } catch {
    // Already exists — update role
    await db
      .update(projectMembers)
      .set({ role })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  }

  log.info('Member added to project', { namespace: 'project', projectId, userId, role });

  return { projectId, userId, role, localPath: null, joinedAt: now };
}

export async function removeMember(projectId: string, userId: string): Promise<void> {
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  log.info('Member removed from project', { namespace: 'project', projectId, userId });
}

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  return (await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))) as ProjectMember[];
}

export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return rows.length > 0;
}

/**
 * Set the local path for a member on a project.
 * Uses upsert logic: creates the project_members record if it doesn't exist (lazy creation),
 * or updates the localPath if it does.
 */
export async function setMemberLocalPath(
  projectId: string,
  userId: string,
  localPath: string,
): Promise<void> {
  const now = new Date().toISOString();

  // Try to update first (most common case)
  const existing = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));

  if (existing.length > 0) {
    await db
      .update(projectMembers)
      .set({ localPath })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  } else {
    // Lazy creation: create the member record with the localPath
    await db.insert(projectMembers).values({
      projectId,
      userId,
      role: 'member',
      localPath,
      joinedAt: now,
    });
    log.info('Member record created lazily via local-path assignment', {
      namespace: 'project',
      projectId,
      userId,
    });
  }
}

/**
 * Get the local path configured by a specific member for a project.
 */
export async function getMemberLocalPath(
  projectId: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ localPath: projectMembers.localPath })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return (rows[0] as { localPath: string | null } | undefined)?.localPath ?? null;
}
