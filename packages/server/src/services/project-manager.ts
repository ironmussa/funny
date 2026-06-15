/**
 * Project management service for the central server.
 * Source of truth for team projects and memberships.
 */

import type { Role } from '@funny/shared/auth/roles';
import { user } from '@funny/shared/db/schema-sqlite';
import { createGrantRepository } from '@funny/shared/repositories';
import { eq, and, inArray } from 'drizzle-orm';

import { db, dbAll, dbRun, schema } from '../db/index.js';
import { projectMembers } from '../db/schema.js';
import { log } from '../lib/logger.js';

// unified-rbac-grants Phase 4: dual-write membership into `resource_grants`
// (project rows) alongside `project_members`, so new memberships populate the
// unified table immediately. Reads stay on `project_members` (still
// authoritative for role + localPath shape) — cutover happens after backfill.
const grants = createGrantRepository({ db, schema, dbAll, dbRun });

/** Legacy project role string → canonical lattice role. */
function projectRoleToCanonical(role: string): Role {
  if (role === 'admin') return 'admin';
  if (role === 'owner') return 'owner';
  if (role === 'viewer') return 'viewer';
  return 'contributor'; // 'member' and any legacy/default value
}

// ── Types ────────────────────────────────────────────────

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: string;
  localPath: string | null;
  joinedAt: string;
}

/** A project member joined with their display fields (for the Collaborators UI). */
export interface ProjectMemberWithUser extends ProjectMember {
  user: { name: string; username: string | null; email: string } | null;
}

// ── Membership ───────────────────────────────────────────

export async function addMember(
  projectId: string,
  userId: string,
  role: string = 'member',
): Promise<ProjectMember> {
  const now = new Date().toISOString();

  // Upsert: insert or update role on conflict
  await db
    .insert(projectMembers)
    .values({ projectId, userId, role, joinedAt: now })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role },
    });

  // Dual-write the unified grant (project row).
  await grants.upsertGrant({
    subjectId: userId,
    resourceType: 'project',
    resourceId: projectId,
    role: projectRoleToCanonical(role),
    grantedBy: userId, // best-effort; route-level actor wiring lands in Phase 7
  });

  log.info('Member added to project', { namespace: 'project', projectId, userId, role });

  return { projectId, userId, role, localPath: null, joinedAt: now };
}

export async function removeMember(projectId: string, userId: string): Promise<void> {
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  await grants.deleteGrant(userId, 'project', projectId);
  log.info('Member removed from project', { namespace: 'project', projectId, userId });
}

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  return (await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))) as ProjectMember[];
}

/** Like {@link listMembers} but joins each member with their display fields. */
export async function listMembersWithUsers(projectId: string): Promise<ProjectMemberWithUser[]> {
  const members = await listMembers(projectId);
  if (members.length === 0) return [];

  const ids = members.map((m) => m.userId);
  const users = (await db
    .select({ id: user.id, name: user.name, username: user.username, email: user.email })
    .from(user)
    .where(inArray(user.id, ids))) as Array<{
    id: string;
    name: string;
    username: string | null;
    email: string;
  }>;
  const byId = new Map(users.map((u) => [u.id, u]));

  return members.map((m) => {
    const u = byId.get(m.userId);
    return { ...m, user: u ? { name: u.name, username: u.username, email: u.email } : null };
  });
}

export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  // Expand phase: reads stay on `project_members` (authoritative). Reads switch
  // to `resource_grants` at cutover (Phase 8), after grant-cleanup-on-delete
  // lands — project grant rows are polymorphic and don't cascade on project
  // delete. Dual-write keeps the two in lockstep meanwhile.
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
