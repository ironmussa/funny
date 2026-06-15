/**
 * Tests for the server database schema.
 *
 * Verifies all tables are created correctly and foreign key constraints work.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import {
  createTestDb,
  seedProject,
  seedThread,
  seedMessage,
  seedPipeline,
  seedRunner,
  seedRunnerProjectAssignment,
  seedProjectMember,
  seedResourceGrant,
  seedTeamProject,
  seedThreadEvent,
} from '../helpers/test-db.js';

describe('Database Schema', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
  });

  test('all core tables exist and accept inserts', () => {
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
    seedMessage(testDb.db, { id: 'm1', threadId: 't1' });
    seedPipeline(testDb.db, { id: 'pipe1', projectId: 'p1' });
    seedThreadEvent(testDb.db, { id: 'evt1', threadId: 't1' });

    expect(testDb.db.select().from(testDb.schema.projects).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.threads).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.messages).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.pipelines).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.threadEvents).all()).toHaveLength(1);
  });

  test('server-only tables exist and accept inserts', () => {
    seedProject(testDb.db, { id: 'p1' });
    seedRunner(testDb.db, { id: 'r1' });
    seedRunnerProjectAssignment(testDb.db, { runnerId: 'r1', projectId: 'p1' });
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'u1' });
    seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p1' });

    expect(testDb.db.select().from(testDb.schema.runners).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.runnerProjectAssignments).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.projectMembers).all()).toHaveLength(1);
    expect(testDb.db.select().from(testDb.schema.teamProjects).all()).toHaveLength(1);
  });

  // unified-rbac-grants, Phase 1: data model only (no resolver/behavior yet).
  describe('resource_grants (unified-rbac-grants)', () => {
    test('round-trips a grant', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedResourceGrant(testDb.db, {
        subjectId: 'u1',
        resourceType: 'thread',
        resourceId: 't1',
        role: 'contributor',
        grantedBy: 'owner-1',
      });

      const rows = testDb.db.select().from(testDb.schema.resourceGrants).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('contributor');
      expect(rows[0].resourceType).toBe('thread');
    });

    test('composite PK makes a re-grant idempotent (upsert, not duplicate)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      const base = {
        subjectId: 'u1',
        resourceType: 'thread',
        resourceId: 't1',
        grantedBy: 'owner-1',
        createdAt: new Date().toISOString(),
      };

      testDb.db
        .insert(testDb.schema.resourceGrants)
        .values({ ...base, role: 'viewer' })
        .run();
      // Re-grant with a different role must update the single row, not add one.
      testDb.db
        .insert(testDb.schema.resourceGrants)
        .values({ ...base, role: 'contributor' })
        .onConflictDoUpdate({
          target: [
            testDb.schema.resourceGrants.subjectId,
            testDb.schema.resourceGrants.resourceType,
            testDb.schema.resourceGrants.resourceId,
          ],
          set: { role: 'contributor' },
        })
        .run();

      const rows = testDb.db.select().from(testDb.schema.resourceGrants).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('contributor');
    });
  });

  test('project_member_config + projects.organization_id exist and accept inserts', () => {
    seedProject(testDb.db, { id: 'p1', organizationId: 'org-1' });
    testDb.db
      .insert(testDb.schema.projectMemberConfig)
      .values({
        projectId: 'p1',
        userId: 'u1',
        localPath: '/home/u1/p1',
        joinedAt: new Date().toISOString(),
      })
      .run();

    const cfg = testDb.db.select().from(testDb.schema.projectMemberConfig).all();
    expect(cfg).toHaveLength(1);
    expect(cfg[0].localPath).toBe('/home/u1/p1');

    const proj = testDb.db
      .select()
      .from(testDb.schema.projects)
      .where(eq(testDb.schema.projects.id, 'p1'))
      .get();
    expect(proj!.organizationId).toBe('org-1');
  });

  test('instance_settings table works', () => {
    testDb.db
      .insert(testDb.schema.instanceSettings)
      .values({
        key: 'smtp_host',
        value: 'mail.example.com',
        updatedAt: new Date().toISOString(),
      })
      .run();

    const setting = testDb.db
      .select()
      .from(testDb.schema.instanceSettings)
      .where(eq(testDb.schema.instanceSettings.key, 'smtp_host'))
      .get();

    expect(setting!.value).toBe('mail.example.com');
  });

  describe('foreign key constraints', () => {
    test('thread references project (cascade delete)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const threads = testDb.db.select().from(testDb.schema.threads).all();
      expect(threads).toHaveLength(0);
    });

    test('message references thread (cascade delete)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });
      seedMessage(testDb.db, { id: 'm1', threadId: 't1' });

      testDb.db.delete(testDb.schema.threads).where(eq(testDb.schema.threads.id, 't1')).run();

      const messages = testDb.db.select().from(testDb.schema.messages).all();
      expect(messages).toHaveLength(0);
    });

    test('runner project assignment references runner (cascade delete)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedRunner(testDb.db, { id: 'r1' });
      seedRunnerProjectAssignment(testDb.db, { runnerId: 'r1', projectId: 'p1' });

      testDb.db.delete(testDb.schema.runners).where(eq(testDb.schema.runners.id, 'r1')).run();

      const assignments = testDb.db.select().from(testDb.schema.runnerProjectAssignments).all();
      expect(assignments).toHaveLength(0);
    });

    test('team project references project (cascade delete)', () => {
      seedProject(testDb.db, { id: 'p1' });
      seedTeamProject(testDb.db, { teamId: 'org-1', projectId: 'p1' });

      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, 'p1')).run();

      const teamProjects = testDb.db.select().from(testDb.schema.teamProjects).all();
      expect(teamProjects).toHaveLength(0);
    });
  });

  describe('unique constraints', () => {
    test('runner tokens must be unique', () => {
      seedRunner(testDb.db, { id: 'r1', token: 'same-token' });

      expect(() => {
        seedRunner(testDb.db, { id: 'r2', token: 'same-token' });
      }).toThrow();
    });

    test('user_profiles user_id is unique', () => {
      testDb.db
        .insert(testDb.schema.userProfiles)
        .values({
          id: 'up1',
          userId: 'u1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(() => {
        testDb.db
          .insert(testDb.schema.userProfiles)
          .values({
            id: 'up2',
            userId: 'u1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run();
      }).toThrow();
    });
  });
});
