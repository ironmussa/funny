import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

/**
 * Regression tests for the project-collaborator model.
 *
 * These cover the three bugs that made "add a user to a project" non-functional:
 *   1. The project owner could never add the FIRST member (empty member list
 *      403'd everyone, including the owner) — POST /:id/members.
 *   2. A collaborator never saw the shared project in their list — GET /api/projects
 *      only returned owned projects.
 *   3. A collaborator was denied the project's sub-resources (commands/hooks/…)
 *      because access control ignored project_members — GET /:id/commands.
 *
 * Each test fails against the pre-fix code and passes with it.
 */
import { user } from '@funny/shared/db/schema-sqlite';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

describe('project collaborators', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'owner', path: '/tmp/p1' });
  });

  describe('Bug 1 — owner can add the first member', () => {
    test('owner (no member row) adds the first collaborator → 201', async () => {
      const res = await t.requestAs('owner').post('/api/projects/p1/members', { userId: 'alice' });
      expect(res.status).toBe(201);

      const pm = await import('../../services/project-manager.js');
      expect(await pm.isProjectMember('p1', 'alice')).toBe(true);
    });

    test('a non-owner, non-admin cannot add members → 403', async () => {
      const res = await t
        .requestAs('stranger')
        .post('/api/projects/p1/members', { userId: 'alice' });
      expect(res.status).toBe(403);
    });

    test('an existing admin member (not owner) can add members → 201', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'admin-user', role: 'admin' });
      const res = await t
        .requestAs('admin-user')
        .post('/api/projects/p1/members', { userId: 'alice' });
      expect(res.status).toBe(201);
    });
  });

  describe('Bug 2 — collaborator sees the shared project', () => {
    test('a member sees the project they were added to, flagged needsSetup', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'alice', role: 'member' });

      const res = await t.requestAs('alice').get('/api/projects');
      expect(res.status).toBe(200);
      const projects = (await res.json()) as any[];

      const p1 = projects.find((p) => p.id === 'p1');
      expect(p1).toBeDefined();
      expect(p1.isTeamProject).toBe(true);
      expect(p1.needsSetup).toBe(true); // no local path configured yet
    });

    test('member with a configured local path is not flagged needsSetup', async () => {
      seedProjectMember(t.db as any, {
        projectId: 'p1',
        userId: 'alice',
        role: 'member',
        localPath: '/home/alice/p1',
      });

      const res = await t.requestAs('alice').get('/api/projects');
      const projects = (await res.json()) as any[];
      const p1 = projects.find((p) => p.id === 'p1');
      expect(p1.needsSetup).toBe(false);
      expect(p1.localPath).toBe('/home/alice/p1');
    });

    test('a stranger does not see the project', async () => {
      const res = await t.requestAs('stranger').get('/api/projects');
      const projects = (await res.json()) as any[];
      expect(projects.find((p) => p.id === 'p1')).toBeUndefined();
    });

    test('the owner is not double-listed via their seeded member row', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'owner', role: 'admin' });
      const res = await t.requestAs('owner').get('/api/projects');
      const projects = (await res.json()) as any[];
      expect(projects.filter((p) => p.id === 'p1')).toHaveLength(1);
    });
  });

  describe('Bug 3 — collaborator can access sub-resources', () => {
    test('a member can list project commands → 200', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'alice', role: 'member' });
      const res = await t.requestAs('alice').get('/api/projects/p1/commands');
      expect(res.status).toBe(200);
    });

    test('a stranger is denied project commands → 404', async () => {
      const res = await t.requestAs('stranger').get('/api/projects/p1/commands');
      expect(res.status).toBe(404);
    });
  });

  describe('2b — only project admins may edit shared config (startup commands)', () => {
    test('a plain member can READ commands but cannot create one → 403', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'alice', role: 'member' });

      const read = await t.requestAs('alice').get('/api/projects/p1/commands');
      expect(read.status).toBe(200);

      const write = await t
        .requestAs('alice')
        .post('/api/projects/p1/commands', { label: 'dev', command: 'bun dev' });
      expect(write.status).toBe(403);
    });

    test('the owner can create a command → 201', async () => {
      const res = await t
        .requestAs('owner')
        .post('/api/projects/p1/commands', { label: 'dev', command: 'bun dev' });
      expect(res.status).toBe(201);
    });

    test('an admin member can create a command → 201', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'admin-user', role: 'admin' });
      const res = await t
        .requestAs('admin-user')
        .post('/api/projects/p1/commands', { label: 'dev', command: 'bun dev' });
      expect(res.status).toBe(201);
    });
  });

  describe('2b — GET /api/projects exposes the caller role', () => {
    test('owner sees role "owner"; member sees their member role', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'alice', role: 'member' });
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'admin' });

      const asOwner = await (await t.requestAs('owner').get('/api/projects')).json();
      expect(asOwner.find((p: any) => p.id === 'p1')?.role).toBe('owner');

      const asAlice = await (await t.requestAs('alice').get('/api/projects')).json();
      expect(asAlice.find((p: any) => p.id === 'p1')?.role).toBe('member');

      const asBob = await (await t.requestAs('bob').get('/api/projects')).json();
      expect(asBob.find((p: any) => p.id === 'p1')?.role).toBe('admin');
    });
  });

  describe('2b — member sets their local path (team mode, no server fs check)', () => {
    test('a member can save a local path that does not exist on the server → 200', async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'alice', role: 'member' });

      // The path lives on the member's runner, not this server — the route must
      // not fs-check it (that always failed in team mode).
      const res = await t
        .requestAs('alice')
        .post('/api/projects/p1/local-path', { localPath: '/home/alice/work/backend-v2' });
      expect(res.status).toBe(200);

      const pm = await import('../../services/project-manager.js');
      expect(await pm.getMemberLocalPath('p1', 'alice')).toBe('/home/alice/work/backend-v2');
    });

    test('rejects a non-absolute path → 400', async () => {
      const res = await t
        .requestAs('alice')
        .post('/api/projects/p1/local-path', { localPath: 'relative/path' });
      expect(res.status).toBe(400);
    });
  });

  describe('owner seeding on project creation', () => {
    test('createProject seeds the owner as an admin member', async () => {
      const projectRepo = await import('../../services/project-repository.js');
      const pm = await import('../../services/project-manager.js');

      // skipFsCheck=true bypasses the git-repo filesystem validation.
      const result = await projectRepo.createProject(
        'Seeded',
        '/tmp/seeded',
        'owner-2',
        null,
        true,
      );
      expect(result.isOk()).toBe(true);
      const projectId = result._unsafeUnwrap().id;

      const members = await pm.listMembers(projectId);
      const owner = members.find((m) => m.userId === 'owner-2');
      expect(owner?.role).toBe('admin');
    });
  });

  describe('GET /api/projects/:id/members — enriched with user display fields', () => {
    test('members carry their user name/username for the Collaborators UI', async () => {
      const now = new Date().toISOString();
      (t.db as any)
        .insert(user)
        .values([
          {
            id: 'u-carol',
            name: 'Carol Danvers',
            email: 'carol@local.host',
            username: 'carol',
            emailVerified: 0,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'u-carol', role: 'member' });

      const res = await t.requestAs('owner').get('/api/projects/p1/members');
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as { members: any[] };
      const carol = members.find((m) => m.userId === 'u-carol');
      expect(carol?.user?.username).toBe('carol');
      expect(carol?.user?.name).toBe('Carol Danvers');
    });
  });

  describe('GET /api/users/search', () => {
    test('finds users by username, name, or email', async () => {
      const now = new Date().toISOString();
      (t.db as any)
        .insert(user)
        .values([
          {
            id: 'u-alice',
            name: 'Alice Wonderland',
            email: 'alice@local.host',
            username: 'alice',
            emailVerified: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'u-bob',
            name: 'Bob Builder',
            email: 'bob@local.host',
            username: 'bob',
            emailVerified: 0,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();

      const byUsername = await t.requestAs('owner').get('/api/users/search?q=ali');
      const rows = (await byUsername.json()) as any[];
      expect(rows.map((r) => r.id)).toContain('u-alice');
      expect(rows.map((r) => r.id)).not.toContain('u-bob');

      // Must never leak sensitive fields.
      expect(rows[0]).not.toHaveProperty('role');
      expect(rows[0]).not.toHaveProperty('banned');
    });

    test('empty query returns an empty list', async () => {
      const res = await t.requestAs('owner').get('/api/users/search?q=');
      expect(await res.json()).toEqual([]);
    });
  });
});
