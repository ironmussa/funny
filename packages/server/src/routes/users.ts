/**
 * User lookup routes for the central server.
 *
 * Supports the project-collaborator flow: a project owner/admin needs to find
 * an existing user account by name/username/email to add them as a member.
 * This is intentionally lighter-weight than the Better Auth admin user list
 * (which is gated to global admins) — an authenticated user may resolve users
 * they share an organization or project with (admins: anyone) to a minimal
 * shape (id + display fields + email). It never
 * exposes credentials, tokens, ban state, or email-verification status.
 */

import { member, projectMembers, projects, user } from '@funny/shared/db/schema-sqlite';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, dbAll } from '../db/index.js';
import type { ServerEnv } from '../lib/types.js';

export const userRoutes = new Hono<ServerEnv>();

interface UserSearchResult {
  id: string;
  username: string | null;
  name: string;
  email: string;
}

/** Shortest query accepted — a 1-char term would enumerate nearly every user. */
const MIN_USER_SEARCH_LENGTH = 2;

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself; pair with `ESCAPE '\\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function likeEscaped(
  column: typeof user.username | typeof user.name | typeof user.email,
  q: string,
) {
  return sql`${column} like ${`%${escapeLike(q)}%`} escape '\\'`;
}

/**
 * Ids of users the caller is related to: members of any organization the
 * caller belongs to, plus owners and members of any project the caller owns or
 * is a member of. A non-admin caller can only discover these users — never the
 * whole user table.
 */
async function relatedUserIds(callerId: string): Promise<string[]> {
  const ids = new Set<string>([callerId]);

  const orgRows = (await dbAll(
    db.select({ orgId: member.organizationId }).from(member).where(eq(member.userId, callerId)),
  )) as Array<{ orgId: string }>;
  const orgIds = orgRows.map((r) => r.orgId);
  if (orgIds.length > 0) {
    const orgMembers = (await dbAll(
      db
        .select({ userId: member.userId })
        .from(member)
        .where(inArray(member.organizationId, orgIds)),
    )) as Array<{ userId: string }>;
    for (const r of orgMembers) ids.add(r.userId);
  }

  const owned = (await dbAll(
    db.select({ id: projects.id }).from(projects).where(eq(projects.userId, callerId)),
  )) as Array<{ id: string }>;
  const joined = (await dbAll(
    db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, callerId)),
  )) as Array<{ id: string }>;
  const projectIds = [...new Set([...owned, ...joined].map((r) => r.id))];
  if (projectIds.length > 0) {
    const coMembers = (await dbAll(
      db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(inArray(projectMembers.projectId, projectIds)),
    )) as Array<{ userId: string }>;
    const owners = (await dbAll(
      db.select({ userId: projects.userId }).from(projects).where(inArray(projects.id, projectIds)),
    )) as Array<{ userId: string }>;
    for (const r of [...coMembers, ...owners]) ids.add(r.userId);
  }

  return [...ids];
}

/**
 * GET /api/users/search?q=<term> — find users by username, name, or email.
 *
 * Global admins search every account. Everyone else only sees users they share
 * an organization or a project with, so the endpoint cannot be used to
 * enumerate the full user directory (emails included).
 */
userRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < MIN_USER_SEARCH_LENGTH) return c.json<UserSearchResult[]>([]);

  const callerId = c.get('userId') as string;
  const isAdmin = c.get('userRole') === 'admin';

  const match = or(
    likeEscaped(user.username, q),
    likeEscaped(user.name, q),
    likeEscaped(user.email, q),
  );
  const where = isAdmin ? match : and(match, inArray(user.id, await relatedUserIds(callerId)));

  const rows = await dbAll(
    db
      .select({
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
      })
      .from(user)
      .where(where)
      .orderBy(asc(user.username), asc(user.name))
      .limit(20),
  );

  return c.json(rows as UserSearchResult[]);
});
