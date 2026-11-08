/**
 * Regression test: Better Auth's session cookie cache was rejected on every
 * request on SQLite ("Cookie cache payload failed schema validation",
 * `invalid_type` at `user.emailVerified`).
 *
 * The SQLite `user.email_verified` column was a plain `integer`, so Drizzle
 * returned `1`. Better Auth's Drizzle adapter assumes native booleans and does
 * not convert, and since 1.7 the cookie-cache payload is validated against a
 * Zod schema that requires `emailVerified: boolean`. The cache silently fell
 * back to a DB lookup on every request.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { userSchema } from 'better-auth/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import * as schema from '../../db/schema.js';

describe('Better Auth cookie cache on SQLite', () => {
  test('a user read through the Drizzle adapter passes the cookie-cache user schema', async () => {
    // Same DDL as the `027_better_auth_tables` migration (+ display_username).
    const db = drizzle(new Database(':memory:'), { schema });
    db.run(sql`
      CREATE TABLE "user" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        username TEXT UNIQUE,
        display_username TEXT,
        role TEXT,
        banned INTEGER,
        ban_reason TEXT,
        ban_expires TEXT
      )
    `);
    db.run(sql`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('u-admin', 'Admin', 'admin@local.host', 1,
              '2026-03-20T15:23:46.473Z', '2026-03-20T15:23:46.473Z')
    `);

    const adapter = drizzleAdapter(db, {
      provider: 'sqlite',
      schema: { user: schema.user, session: schema.session, account: schema.account },
    })({});
    const user = await adapter.findOne<Record<string, unknown>>({
      model: 'user',
      where: [{ field: 'id', value: 'u-admin' }],
    });

    expect(user?.emailVerified).toBe(true);
    const parsed = userSchema.loose().safeParse(user);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
