/**
 * User lookup routes for the central server.
 *
 * Supports the project-collaborator flow: a project owner/admin needs to find
 * an existing user account by name/username/email to add them as a member.
 * This is intentionally lighter-weight than the Better Auth admin user list
 * (which is gated to global admins) — any authenticated user may resolve other
 * users to a minimal, non-sensitive shape (id + display fields). It never
 * exposes credentials, tokens, ban state, or email-verification status.
 */

import { user } from '@funny/shared/db/schema-sqlite';
import { or, like, asc } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, dbAll } from '../db/index.js';
import type { ServerEnv } from '../lib/types.js';

export const userRoutes = new Hono<ServerEnv>();

export interface UserSearchResult {
  id: string;
  username: string | null;
  name: string;
  email: string;
}

/** GET /api/users/search?q=<term> — find users by username, name, or email. */
userRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 1) return c.json<UserSearchResult[]>([]);

  const pattern = `%${q}%`;
  const rows = await dbAll(
    db
      .select({
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
      })
      .from(user)
      .where(or(like(user.username, pattern), like(user.name, pattern), like(user.email, pattern)))
      .orderBy(asc(user.username), asc(user.name))
      .limit(20),
  );

  return c.json(rows as UserSearchResult[]);
});
