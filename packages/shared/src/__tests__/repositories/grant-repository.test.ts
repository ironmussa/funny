/**
 * Grant repository tests (unified-rbac-grants, Phase 3). Real in-memory SQLite.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createGrantRepository } from '../../repositories/grant-repository.js';
import { createTestDb } from '../helpers/test-db.js';

function makeRepo() {
  const { db, schema, dbAll, dbRun } = createTestDb();
  return createGrantRepository({ db, schema, dbAll, dbRun } as any);
}

describe('grant-repository', () => {
  let repo: ReturnType<typeof createGrantRepository>;
  beforeEach(() => {
    repo = makeRepo();
  });

  test('upsert then read back the grant + role', async () => {
    await repo.upsertGrant({
      subjectId: 'u1',
      resourceType: 'project',
      resourceId: 'p1',
      role: 'admin',
      grantedBy: 'owner-1',
    });

    const grant = await repo.getGrant('u1', 'project', 'p1');
    expect(grant?.role).toBe('admin');
    expect(grant?.grantedBy).toBe('owner-1');
    expect(await repo.getGrantRole('u1', 'project', 'p1')).toBe('admin');
    expect(await repo.getGrantRole('u1', 'project', 'other')).toBeNull();
  });

  test('upsert is idempotent on the composite PK (role updates in place)', async () => {
    const base = { subjectId: 'u1', resourceType: 'thread' as const, resourceId: 't1' };
    await repo.upsertGrant({ ...base, role: 'viewer', grantedBy: 'o1' });
    await repo.upsertGrant({ ...base, role: 'contributor', grantedBy: 'o2' });

    const all = await repo.listGrantsForResource('thread', 't1');
    expect(all).toHaveLength(1);
    expect(all[0].role).toBe('contributor');
    expect(all[0].grantedBy).toBe('o2');
  });

  test('rejects an invalid role', async () => {
    await expect(
      repo.upsertGrant({
        subjectId: 'u1',
        resourceType: 'project',
        resourceId: 'p1',
        // @ts-expect-error — exercising runtime validation
        role: 'superuser',
        grantedBy: 'o1',
      }),
    ).rejects.toThrow(/Invalid role/);
  });

  test('deleteGrant removes the row (no-op if absent)', async () => {
    await repo.upsertGrant({
      subjectId: 'u1',
      resourceType: 'thread',
      resourceId: 't1',
      role: 'viewer',
      grantedBy: 'o1',
    });
    await repo.deleteGrant('u1', 'thread', 't1');
    expect(await repo.getGrant('u1', 'thread', 't1')).toBeNull();
    // second delete is a no-op, not an error
    await repo.deleteGrant('u1', 'thread', 't1');
  });

  test('listResourcesForSubject filters by type', async () => {
    await repo.upsertGrant({
      subjectId: 'u1',
      resourceType: 'project',
      resourceId: 'p1',
      role: 'admin',
      grantedBy: 'o1',
    });
    await repo.upsertGrant({
      subjectId: 'u1',
      resourceType: 'thread',
      resourceId: 't1',
      role: 'viewer',
      grantedBy: 'o1',
    });

    const projects = await repo.listResourcesForSubject('u1', 'project');
    expect(projects).toHaveLength(1);
    expect(projects[0].resourceId).toBe('p1');
  });
});
