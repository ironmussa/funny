/**
 * Tests for project-repository.ts
 *
 * Tests project CRUD, organization association, member paths,
 * and reordering against an in-memory SQLite database.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { eq, and, asc, inArray, notInArray } from 'drizzle-orm';

import {
  createTestDb,
  seedProject,
  seedTeamProject,
  seedProjectMember,
} from '../helpers/test-db.js';

describe('project-repository', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  describe('project CRUD', () => {
    test('insert and retrieve a project', () => {
      seedProject(testDb.db, {
        id: 'p1',
        name: 'My Project',
        path: '/home/user/repo',
        userId: 'user-1',
      });

      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(project).toBeDefined();
      expect(project!.name).toBe('My Project');
      expect(project!.path).toBe('/home/user/repo');
      expect(project!.userId).toBe('user-1');
    });

    test('list projects for a user', () => {
      seedProject(testDb.db, { id: 'p1', userId: 'user-1', name: 'P1', path: '/a' });
      seedProject(testDb.db, { id: 'p2', userId: 'user-1', name: 'P2', path: '/b' });
      seedProject(testDb.db, { id: 'p3', userId: 'user-2', name: 'P3', path: '/c' });

      const user1Projects = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.userId, 'user-1'))
        .all();

      expect(user1Projects).toHaveLength(2);
    });

    test('list all projects for __local__ user', () => {
      seedProject(testDb.db, { id: 'p1', userId: '__local__', name: 'P1', path: '/a' });
      seedProject(testDb.db, { id: 'p2', userId: '__local__', name: 'P2', path: '/b' });

      const allProjects = testDb.db
        .select()
        .from(testDb.schema.projects)
        .orderBy(asc(testDb.schema.projects.sortOrder))
        .all();

      expect(allProjects).toHaveLength(2);
    });

    test('update project fields', () => {
      seedProject(testDb.db, { id: 'p1', name: 'Old Name' });

      testDb.db
        .update(testDb.schema.projects)
        .set({ name: 'New Name', color: '#FF0000' })
        .where(eq(testDb.schema.projects.id, 'p1'))
        .run();

      const updated = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(updated!.name).toBe('New Name');
      expect(updated!.color).toBe('#FF0000');
    });

    test('delete a project', () => {
      seedProject(testDb.db, { id: 'p1' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const result = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(result).toBeUndefined();
    });

    test('project sortOrder determines display order', () => {
      seedProject(testDb.db, { id: 'p1', name: 'Third', sortOrder: 2, path: '/a' });
      seedProject(testDb.db, { id: 'p2', name: 'First', sortOrder: 0, path: '/b' });
      seedProject(testDb.db, { id: 'p3', name: 'Second', sortOrder: 1, path: '/c' });

      const ordered = testDb.db
        .select()
        .from(testDb.schema.projects)
        .orderBy(asc(testDb.schema.projects.sortOrder))
        .all();

      expect(ordered[0].name).toBe('First');
      expect(ordered[1].name).toBe('Second');
      expect(ordered[2].name).toBe('Third');
    });
  });

  describe('organization projects', () => {
    test('associate project with organization', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p1' });

      const rows = testDb.db
        .select()
        .from(testDb.schema.teamProjects)
        .where(eq(testDb.schema.teamProjects.teamId, 'org-1'))
        .all();

      expect(rows).toHaveLength(1);
      expect(rows[0].projectId).toBe('p1');
    });

    test('list projects in an organization', () => {
      seedProject(testDb.db, { id: 'p1', name: 'Org P1', path: '/a' });
      seedProject(testDb.db, { id: 'p2', name: 'Org P2', path: '/b' });
      seedProject(testDb.db, { id: 'p3', name: 'Personal', path: '/c' });

      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p1' });
      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p2' });

      const teamProjectRows = testDb.db
        .select({ projectId: testDb.schema.teamProjects.projectId })
        .from(testDb.schema.teamProjects)
        .where(eq(testDb.schema.teamProjects.teamId, 'org-1'))
        .all();

      const projectIds = teamProjectRows.map((r) => r.projectId);
      expect(projectIds).toHaveLength(2);

      const orgProjects = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(inArray(testDb.schema.projects.id, projectIds))
        .all();

      expect(orgProjects).toHaveLength(2);
    });

    test('check if project belongs to organization', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p1' });

      const inOrg = testDb.db
        .select()
        .from(testDb.schema.teamProjects)
        .where(
          and(
            eq(testDb.schema.teamProjects.teamId, 'org-1'),
            eq(testDb.schema.teamProjects.projectId, 'p1'),
          ),
        )
        .get();

      expect(inOrg).toBeDefined();

      const notInOrg = testDb.db
        .select()
        .from(testDb.schema.teamProjects)
        .where(
          and(
            eq(testDb.schema.teamProjects.teamId, 'org-1'),
            eq(testDb.schema.teamProjects.projectId, 'p-nonexistent'),
          ),
        )
        .get();

      expect(notInOrg).toBeUndefined();
    });

    test('exclude org projects from personal listing', () => {
      seedProject(testDb.db, { id: 'p-org', name: 'Org Project', userId: 'u1', path: '/a' });
      seedProject(testDb.db, { id: 'p-personal', name: 'Personal', userId: 'u1', path: '/b' });
      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p-org' });

      const orgIds = testDb.db
        .select({ projectId: testDb.schema.teamProjects.projectId })
        .from(testDb.schema.teamProjects)
        .all()
        .map((r) => r.projectId);

      const personal = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(
          and(
            eq(testDb.schema.projects.userId, 'u1'),
            notInArray(testDb.schema.projects.id, orgIds),
          ),
        )
        .all();

      expect(personal).toHaveLength(1);
      expect(personal[0].id).toBe('p-personal');
    });
  });

  describe('project members', () => {
    test('add and retrieve a project member', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProjectMember(testDb.db, {
        projectId: 'p1',
        userId: 'user-2',
        localPath: '/home/user2/repo',
      });

      const member = testDb.db
        .select()
        .from(testDb.schema.projectMembers)
        .where(
          and(
            eq(testDb.schema.projectMembers.projectId, 'p1'),
            eq(testDb.schema.projectMembers.userId, 'user-2'),
          ),
        )
        .get();

      expect(member).toBeDefined();
      expect(member!.localPath).toBe('/home/user2/repo');
    });

    test('member local path can be null', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedProjectMember(testDb.db, {
        projectId: 'p1',
        userId: 'user-3',
        localPath: null,
      });

      const member = testDb.db
        .select({ localPath: testDb.schema.projectMembers.localPath })
        .from(testDb.schema.projectMembers)
        .where(
          and(
            eq(testDb.schema.projectMembers.projectId, 'p1'),
            eq(testDb.schema.projectMembers.userId, 'user-3'),
          ),
        )
        .get();

      expect(member!.localPath).toBeNull();
    });

    test('cascade delete removes members when project is deleted', () => {
      seedProject(testDb.db, { id: 'p-del' });
      seedProjectMember(testDb.db, { projectId: 'p-del', userId: 'u1' });
      seedProjectMember(testDb.db, { projectId: 'p-del', userId: 'u2' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p-del')).run();

      const members = testDb.db.select().from(testDb.schema.projectMembers).all();
      expect(members).toHaveLength(0);
    });
  });

  describe('reorder projects', () => {
    test('reorder projects by updating sortOrder', () => {
      seedProject(testDb.db, { id: 'p1', name: 'A', sortOrder: 0, path: '/a' });
      seedProject(testDb.db, { id: 'p2', name: 'B', sortOrder: 1, path: '/b' });
      seedProject(testDb.db, { id: 'p3', name: 'C', sortOrder: 2, path: '/c' });

      // Reorder: C, A, B
      const newOrder = ['p3', 'p1', 'p2'];
      for (let i = 0; i < newOrder.length; i++) {
        testDb.db
          .update(testDb.schema.projects)
          .set({ sortOrder: i })
          .where(eq(testDb.schema.projects.id, newOrder[i]))
          .run();
      }

      const ordered = testDb.db
        .select()
        .from(testDb.schema.projects)
        .orderBy(asc(testDb.schema.projects.sortOrder))
        .all();

      expect(ordered[0].name).toBe('C');
      expect(ordered[1].name).toBe('A');
      expect(ordered[2].name).toBe('B');
    });
  });

  describe('project URLs field', () => {
    test('store and retrieve URLs as JSON', () => {
      seedProject(testDb.db, { id: 'p1' });

      const urls = ['https://app.example.com', 'https://api.example.com'];
      testDb.db
        .update(testDb.schema.projects)
        .set({ urls: JSON.stringify(urls) })
        .where(eq(testDb.schema.projects.id, 'p1'))
        .run();

      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      const parsed = JSON.parse(project!.urls!);
      expect(parsed).toEqual(urls);
    });

    test('URLs field can be null', () => {
      seedProject(testDb.db, { id: 'p1' });

      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, 'p1'))
        .get();

      expect(project!.urls).toBeNull();
    });
  });
});
