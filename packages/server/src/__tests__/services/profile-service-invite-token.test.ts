/**
 * Tests for runner invite token TTL + single-use semantics (Security H5).
 *
 * Uses the global DB singleton initialized in-memory via createTestApp, so
 * profile-service's `db` import resolves to the same SQLite instance the
 * tests seed against.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('runner invite token (H5)', () => {
  let t: TestApp;
  let ps: typeof import('../../services/profile-service.js');

  beforeAll(async () => {
    t = await createTestApp();
    ps = await import('../../services/profile-service.js');
  });

  beforeEach(() => {
    t.cleanup();
  });

  test('a freshly issued token validates exactly once', async () => {
    const token = await ps.getOrCreateRunnerInviteToken('user-h5-a');
    expect(token).toMatch(/^utkn_/);

    // First validation succeeds.
    const first = await ps.validateRunnerInviteToken(token);
    expect(first).toBe('user-h5-a');

    // Second validation is rejected — single-use.
    const second = await ps.validateRunnerInviteToken(token);
    expect(second).toBeNull();
  });

  test('rotate invalidates the previous token immediately', async () => {
    const token1 = await ps.getOrCreateRunnerInviteToken('user-h5-b');
    const token2 = await ps.rotateRunnerInviteToken('user-h5-b');
    expect(token2).not.toBe(token1);

    // The old token is no longer accepted.
    expect(await ps.validateRunnerInviteToken(token1)).toBeNull();
    // The new token works.
    expect(await ps.validateRunnerInviteToken(token2)).toBe('user-h5-b');
  });

  test('an expired token is rejected even if unused', async () => {
    // Seed a user_profiles row with an expired token.
    const schema = t.schema;
    const db = t.db;
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.insert(schema.userProfiles).values({
      id: 'p-exp',
      userId: 'user-h5-c',
      runnerInviteToken: 'utkn_expired_xyz',
      runnerInviteTokenExpiresAt: past,
      setupCompleted: 0,
      createdAt: past,
      updatedAt: past,
    });

    expect(await ps.validateRunnerInviteToken('utkn_expired_xyz')).toBeNull();
  });

  test('unknown token is rejected', async () => {
    expect(await ps.validateRunnerInviteToken('utkn_does_not_exist')).toBeNull();
  });

  test('getOrCreate rotates a consumed token transparently', async () => {
    const token1 = await ps.getOrCreateRunnerInviteToken('user-h5-d');
    expect(await ps.validateRunnerInviteToken(token1)).toBe('user-h5-d');

    // After consumption, getOrCreate should return a fresh token rather than
    // the spent one.
    const token2 = await ps.getOrCreateRunnerInviteToken('user-h5-d');
    expect(token2).not.toBe(token1);
    expect(await ps.validateRunnerInviteToken(token1)).toBeNull();
    expect(await ps.validateRunnerInviteToken(token2)).toBe('user-h5-d');
  });
});
