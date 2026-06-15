/**
 * Unit tests for project-manager membership helpers used by project routes.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

describe('project-manager service', () => {
  let t: TestApp;
  let pm: typeof import('../../services/project-manager.js');

  beforeAll(async () => {
    t = await createTestApp();
    pm = await import('../../services/project-manager.js');
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
  });

  describe('addMember / listMembers / isProjectMember', () => {
    test('adds a member and lists them', async () => {
      await pm.addMember('p1', 'user-2', 'member');

      expect(await pm.isProjectMember('p1', 'user-2')).toBe(true);
      const members = await pm.listMembers('p1');
      expect(members).toHaveLength(1);
      expect(members[0]?.userId).toBe('user-2');
      expect(members[0]?.role).toBe('member');
    });

    test('upserts role on duplicate add', async () => {
      await pm.addMember('p1', 'user-2', 'member');
      await pm.addMember('p1', 'user-2', 'admin');

      const members = await pm.listMembers('p1');
      expect(members[0]?.role).toBe('admin');
    });

    test('dual-writes a unified project grant with the canonical role', async () => {
      const { createGrantRepository } = await import('@funny/shared/repositories');
      const { db, dbAll, dbRun, schema } = await import('../../db/index.js');
      const grants = createGrantRepository({ db, schema, dbAll, dbRun } as any);

      await pm.addMember('p1', 'user-2', 'member'); // legacy 'member' → canonical 'contributor'
      expect(await grants.getGrantRole('user-2', 'project', 'p1')).toBe('contributor');

      await pm.addMember('p1', 'user-2', 'admin'); // upsert raises the grant
      expect(await grants.getGrantRole('user-2', 'project', 'p1')).toBe('admin');

      await pm.removeMember('p1', 'user-2');
      expect(await grants.getGrantRole('user-2', 'project', 'p1')).toBeNull();
    });
  });

  describe('removeMember', () => {
    test('removes an existing member', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-2', role: 'member' });

      await pm.removeMember('p1', 'user-2');
      expect(await pm.isProjectMember('p1', 'user-2')).toBe(false);
    });
  });

  describe('setMemberLocalPath / getMemberLocalPath', () => {
    test('updates localPath for an existing member', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'user-1', role: 'admin' });

      await pm.setMemberLocalPath('p1', 'user-1', '/home/user/p1');
      expect(await pm.getMemberLocalPath('p1', 'user-1')).toBe('/home/user/p1');
    });

    test('lazy-creates member row when assigning localPath', async () => {
      await pm.setMemberLocalPath('p1', 'user-3', '/home/user/p3');

      expect(await pm.isProjectMember('p1', 'user-3')).toBe(true);
      expect(await pm.getMemberLocalPath('p1', 'user-3')).toBe('/home/user/p3');
    });
  });
});
