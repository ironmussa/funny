/**
 * Regression tests for the Better Auth `user` table schema.
 *
 * Two bugs broke default-admin seeding on a fresh PostgreSQL database
 * (the SQLite path masked both):
 *
 * 1. The `username()` plugin writes a `displayUsername` field on the user
 *    model. Neither Drizzle schema declared it, so Better Auth's adapter
 *    rejected the insert with `The field "displayUsername" does not exist
 *    in the "user" Drizzle schema`.
 *
 * 2. Better Auth treats `emailVerified` / `banned` as booleans. The pg
 *    schema declared them as INTEGER columns; Postgres is strictly typed
 *    and rejected the boolean values ("column banned is of type integer
 *    but expression is of type boolean"). SQLite stores booleans as 0/1
 *    transparently, so its schema keeps integer columns.
 */
import { describe, expect, test } from 'bun:test';

import { getTableColumns } from 'drizzle-orm';

import { user as pgUser } from '../db/schema.pg.js';
import { user as sqliteUser } from '../db/schema.sqlite.js';

describe('Better Auth user schema', () => {
  test('pg user table declares displayUsername (username plugin requires it)', () => {
    const cols = getTableColumns(pgUser);
    expect(cols.displayUsername).toBeDefined();
    expect(cols.displayUsername.name).toBe('display_username');
  });

  test('sqlite user table declares displayUsername (username plugin requires it)', () => {
    const cols = getTableColumns(sqliteUser);
    expect(cols.displayUsername).toBeDefined();
    expect(cols.displayUsername.name).toBe('display_username');
  });

  test('pg emailVerified and banned are boolean columns (Postgres is strictly typed)', () => {
    const cols = getTableColumns(pgUser);
    expect(cols.emailVerified.getSQLType()).toBe('boolean');
    expect(cols.banned.getSQLType()).toBe('boolean');
  });

  test('sqlite emailVerified and banned stay integer (0/1) columns', () => {
    const cols = getTableColumns(sqliteUser);
    expect(cols.emailVerified.getSQLType()).toBe('integer');
    expect(cols.banned.getSQLType()).toBe('integer');
  });
});
