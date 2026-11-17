import { beforeEach, describe, expect, test } from 'bun:test';

import { findLaunchableProject } from '../../../services/thread-sandboxes/launch-project.js';
import { createTestDb, seedProject, seedProjectMember } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'bob', path: '/home/bob/app' });
});

describe('the project a sandbox thread may start on', () => {
  test('the owner and a contributor member may start one', async () => {
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'alice', role: 'member' });
    expect(await findLaunchableProject('bob', 'p1')).toEqual({ path: '/home/bob/app' });
    expect(await findLaunchableProject('alice', 'p1')).toEqual({ path: '/home/bob/app' });
  });

  test('a viewer member is refused with 403', async () => {
    // `setMemberLocalPath` writes viewer rows like this one for org viewers.
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'alice', role: 'viewer' });
    expect(await findLaunchableProject('alice', 'p1')).toEqual({ refused: 403 });
  });

  test('a caller with no role on the project does not see it', async () => {
    expect(await findLaunchableProject('carol', 'p1')).toBeNull();
    expect(await findLaunchableProject('bob', 'missing')).toBeNull();
  });
});
