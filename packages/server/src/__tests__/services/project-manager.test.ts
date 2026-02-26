import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestDb, seedProject } from '../helpers/test-db.js';

// We test the project manager logic by reimplementing it against the test DB,
// since the real module imports a singleton DB.

describe('ProjectManager', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  function listProjects() {
    return testDb.db.select().from(testDb.schema.projects).all();
  }

  function getProject(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.projects)
      .where(eq(testDb.schema.projects.id, id))
      .get();
  }

  function createProject(id: string, name: string, path: string) {
    const project = {
      id,
      name,
      path,
      createdAt: new Date().toISOString(),
    };
    testDb.db.insert(testDb.schema.projects).values(project).run();
    return project;
  }

  function deleteProject(id: string) {
    testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, id)).run();
  }

  test('listProjects returns empty array initially', () => {
    expect(listProjects()).toEqual([]);
  });

  test('listProjects returns seeded projects', () => {
    seedProject(testDb.db, { id: 'p1', name: 'Project 1' });
    seedProject(testDb.db, { id: 'p2', name: 'Project 2' });

    const projects = listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name)).toContain('Project 1');
    expect(projects.map((p) => p.name)).toContain('Project 2');
  });

  test('getProject returns existing project', () => {
    seedProject(testDb.db, { id: 'p1', name: 'My Project' });
    const project = getProject('p1');
    expect(project).toBeTruthy();
    expect(project!.name).toBe('My Project');
    expect(project!.id).toBe('p1');
  });

  test('getProject returns undefined for non-existent project', () => {
    expect(getProject('nonexistent')).toBeUndefined();
  });

  test('createProject inserts a project', () => {
    const project = createProject('new1', 'New Project', '/path/to/repo');
    expect(project.id).toBe('new1');
    expect(project.name).toBe('New Project');

    const fetched = getProject('new1');
    expect(fetched).toBeTruthy();
    expect(fetched!.path).toBe('/path/to/repo');
  });

  test('createProject sets createdAt', () => {
    const before = new Date().toISOString();
    const project = createProject('p-time', 'Timed', '/path');
    const after = new Date().toISOString();

    expect(project.createdAt >= before).toBe(true);
    expect(project.createdAt <= after).toBe(true);
  });

  test('deleteProject removes the project', () => {
    seedProject(testDb.db, { id: 'to-delete' });
    expect(getProject('to-delete')).toBeTruthy();

    deleteProject('to-delete');
    expect(getProject('to-delete')).toBeUndefined();
  });

  test('deleteProject on non-existent project does not throw', () => {
    expect(() => deleteProject('nonexistent')).not.toThrow();
  });

  test('deleting project cascades to threads', () => {
    seedProject(testDb.db, { id: 'cascade-p' });
    testDb.db
      .insert(testDb.schema.threads)
      .values({
        id: 'cascade-t',
        projectId: 'cascade-p',
        title: 'Thread',
        mode: 'local',
        permissionMode: 'autoEdit',
        status: 'pending',
        cost: 0,
        archived: 0,
        createdAt: new Date().toISOString(),
      })
      .run();

    const threadsBefore = testDb.db.select().from(testDb.schema.threads).all();
    expect(threadsBefore).toHaveLength(1);

    deleteProject('cascade-p');

    const threadsAfter = testDb.db.select().from(testDb.schema.threads).all();
    expect(threadsAfter).toHaveLength(0);
  });
});
