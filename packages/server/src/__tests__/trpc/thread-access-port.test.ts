/**
 * The tRPC thread procedures authorize through the same policy as the REST
 * `requireThread*` middlewares (openspec adopt-trpc-browser-api, task 3.1):
 * owner, view share and steer share on the real DB.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

describe('threadAccessPort', () => {
  let t: TestApp;
  let port: typeof import('../../trpc/ports/thread-access.js').threadAccessPort;

  // Through the share repository, which dual-writes thread_shares and
  // resource_grants exactly like POST /api/threads/:id/shares.
  const share = async (level: 'view' | 'steer') => {
    const { repos } = await import('../../db/repos.js');
    await repos
      .threadShares()
      .createShare({ threadId: 't1', sharedWithUserId: 'user-2', sharedByUserId: 'user-1', level });
  };

  beforeAll(async () => {
    t = await createTestApp();
    ({ threadAccessPort: port } = await import('../../trpc/ports/thread-access.js'));
  });

  beforeEach(() => {
    t.cleanup();
    t.db.run(sql`DELETE FROM thread_shares`);
    t.db.run(sql`DELETE FROM resource_grants`);
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
  });

  test('the owner has every level', async () => {
    for (const level of ['view', 'owner', 'steer'] as const) {
      expect((await port.authorize(level, 't1', 'user-1'))?.id).toBe('t1');
    }
  });

  test('a stranger and a missing thread both get null (404)', async () => {
    for (const level of ['view', 'owner', 'steer'] as const) {
      expect(await port.authorize(level, 't1', 'user-2')).toBeNull();
      expect(await port.authorize(level, 'missing', 'user-1')).toBeNull();
    }
    expect(await port.authorize('view', '', 'user-1')).toBeNull();
  });

  test('a view share admits view only', async () => {
    await share('view');
    expect((await port.authorize('view', 't1', 'user-2'))?.id).toBe('t1');
    expect(await port.authorize('steer', 't1', 'user-2')).toBeNull();
    expect(await port.authorize('owner', 't1', 'user-2')).toBeNull();
  });

  test('a steer share admits steer but never owner', async () => {
    await share('steer');
    expect((await port.authorize('steer', 't1', 'user-2'))?.id).toBe('t1');
    expect(await port.authorize('owner', 't1', 'user-2')).toBeNull();
  });
});
