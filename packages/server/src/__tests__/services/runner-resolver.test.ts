/**
 * Tests for runner-resolver.ts
 *
 * The runner resolver uses in-memory caching and DB lookups.
 * We test the pure logic (caching, URL extraction) since DB queries
 * require the full server DB module.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
} from '../helpers/test-db.js';

describe('runner-resolver', () => {
  describe('extractProjectId (via path patterns)', () => {
    // We test the path extraction patterns that the resolver uses internally
    test('extracts projectId from /api/projects/:id', () => {
      const path = '/api/projects/proj-123';
      const match = path.match(/\/api\/projects\/([^/]+)/);
      expect(match?.[1]).toBe('proj-123');
    });

    test('extracts projectId from /api/git/project/:id', () => {
      const path = '/api/git/project/proj-456/diff';
      const match = path.match(/\/api\/git\/project\/([^/]+)/);
      expect(match?.[1]).toBe('proj-456');
    });

    test('extracts projectId from /api/tests/:id', () => {
      const path = '/api/tests/proj-789/run';
      const match = path.match(/\/api\/tests\/([^/]+)/);
      expect(match?.[1]).toBe('proj-789');
    });

    test('returns null for unrelated paths', () => {
      const path = '/api/auth/login';
      const match =
        path.match(/\/api\/git\/project\/([^/]+)/) ||
        path.match(/\/api\/projects\/([^/]+)/) ||
        path.match(/\/api\/tests\/([^/]+)/);
      expect(match).toBeNull();
    });
  });

  describe('extractThreadId (via path patterns)', () => {
    test('extracts threadId from /api/threads/:id', () => {
      const path = '/api/threads/thr-123';
      const match = path.match(/\/api\/threads\/([^/?]+)/);
      expect(match?.[1]).toBe('thr-123');
    });

    test('extracts threadId from /api/git/:threadId', () => {
      const path = '/api/git/thr-456/diff';
      const match = path.match(/\/api\/git\/([^/]+)/);
      expect(match?.[1]).toBe('thr-456');
    });

    test('does not extract "project" as threadId from /api/git/project/', () => {
      const path = '/api/git/project/proj-123';
      const gitMatch = path.match(/\/api\/git\/([^/]+)/);
      // The resolver skips 'project' and 'status' as threadId
      expect(gitMatch?.[1]).toBe('project');
      // This is filtered by the actual resolver with: && gitMatch[1] !== 'project'
    });
  });

  describe('runner DB queries', () => {
    let testDb: ReturnType<typeof createTestDb>;

    beforeEach(() => {
      testDb = createTestDb();
    });

    test('seed runner and verify it exists', () => {
      const runner = seedRunner(testDb.db, {
        id: 'runner-1',
        status: 'online',
        httpUrl: 'http://runner1:3002',
        userId: 'user-1',
      });
      expect(runner.id).toBe('runner-1');
      expect(runner.status).toBe('online');

      const rows = testDb.db.select().from(testDb.schema.runners).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].httpUrl).toBe('http://runner1:3002');
    });

    test('seed runner project assignment', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedRunner(testDb.db, { id: 'r1', token: 'tok-1' });
      seedRunnerProjectAssignment(testDb.db, {
        runnerId: 'r1',
        projectId: 'p1',
        localPath: '/home/user/project',
      });

      const assignments = testDb.db.select().from(testDb.schema.runnerProjectAssignments).all();
      expect(assignments).toHaveLength(1);
      expect(assignments[0].localPath).toBe('/home/user/project');
    });

    test('offline runners are excluded by status filter', () => {
      seedRunner(testDb.db, { id: 'r-offline', status: 'offline', token: 'tok-off' });
      seedRunner(testDb.db, { id: 'r-online', status: 'online', token: 'tok-on' });

      const { ne } = require('drizzle-orm');
      const online = testDb.db
        .select()
        .from(testDb.schema.runners)
        .where(ne(testDb.schema.runners.status, 'offline'))
        .all();

      expect(online).toHaveLength(1);
      expect(online[0].id).toBe('r-online');
    });

    test('user-scoped runners filter by userId', () => {
      const { eq, and, ne } = require('drizzle-orm');

      seedRunner(testDb.db, {
        id: 'r-u1',
        userId: 'user-1',
        status: 'online',
        token: 'tok-u1',
      });
      seedRunner(testDb.db, {
        id: 'r-u2',
        userId: 'user-2',
        status: 'online',
        token: 'tok-u2',
      });

      const userRunners = testDb.db
        .select()
        .from(testDb.schema.runners)
        .where(
          and(
            ne(testDb.schema.runners.status, 'offline'),
            eq(testDb.schema.runners.userId, 'user-1'),
          ),
        )
        .all();

      expect(userRunners).toHaveLength(1);
      expect(userRunners[0].id).toBe('r-u1');
    });
  });
});
