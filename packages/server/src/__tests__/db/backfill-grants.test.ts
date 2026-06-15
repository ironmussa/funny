import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

/**
 * Backfill golden test (unified-rbac-grants, Phase 6).
 *
 * Seeds the legacy membership tables, runs the backfill, then asserts (a) the
 * unified rows + `projects.organization_id` are correct and (b) the authorizer
 * — wired over the real backfilled data — grants access identically to the
 * legacy model.
 */
import { createAuthorizer } from '@funny/shared/auth/authorizer';
import { createGrantRepository } from '@funny/shared/repositories';
import { eq, sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread, seedProjectMember } from '../helpers/test-db.js';

describe('resource_grants backfill', () => {
  let t: TestApp;
  let backfill: () => Promise<void>;

  beforeAll(async () => {
    t = await createTestApp();
    const mod = await import('../../db/migrate.js');
    backfill = () => mod.backfillResourceGrants((q) => Promise.resolve(t.db.run(q as any)));
  });

  beforeEach(() => {
    t.cleanup();
  });

  function grants() {
    return createGrantRepository({
      db: t.db,
      schema: t.schema,
      dbAll: (q: any) => Promise.resolve(t.db.all(q)),
      dbRun: (q: any) => Promise.resolve(t.db.run(q)),
    } as any);
  }

  test('maps legacy project_members and thread_shares to canonical roles', async () => {
    seedProject(t.db as any, { id: 'p1', userId: 'owner-1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'owner-1' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ana', role: 'member' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'admin' });
    t.db.run(
      sql`INSERT INTO thread_shares (thread_id, shared_with_user_id, shared_by_user_id, level, created_at)
          VALUES ('t1', 'ana', 'owner-1', 'view', '2026-01-01'),
                 ('t1', 'cy', 'owner-1', 'steer', '2026-01-01')`,
    );

    await backfill();
    const g = grants();

    expect(await g.getGrantRole('ana', 'project', 'p1')).toBe('contributor'); // member→contributor
    expect(await g.getGrantRole('bob', 'project', 'p1')).toBe('admin');
    expect(await g.getGrantRole('ana', 'thread', 't1')).toBe('viewer'); // view→viewer
    expect(await g.getGrantRole('cy', 'thread', 't1')).toBe('contributor'); // steer→contributor
  });

  test('denormalizes team_projects into projects.organization_id', async () => {
    seedProject(t.db as any, { id: 'p1', userId: 'owner-1' });
    t.db.run(
      sql`INSERT INTO team_projects (team_id, project_id, created_at) VALUES ('org-9', 'p1', '2026-01-01')`,
    );

    await backfill();

    const proj = t.db
      .select()
      .from(t.schema.projects)
      .where(eq(t.schema.projects.id, 'p1'))
      .get() as any;
    expect(proj.organizationId).toBe('org-9');
  });

  test('is idempotent and preserves Phase-4 dual-written grants', async () => {
    seedProject(t.db as any, { id: 'p1', userId: 'owner-1' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ana', role: 'admin' });
    // A grant already written by the Phase 4 dual-write (different role on purpose).
    await grants().upsertGrant({
      subjectId: 'ana',
      resourceType: 'project',
      resourceId: 'p1',
      role: 'contributor',
      grantedBy: 'owner-1',
    });

    await backfill();
    await backfill(); // re-run: must not duplicate or clobber

    const rows = await grants().listGrantsForResource('project', 'p1');
    expect(rows).toHaveLength(1);
    // ON CONFLICT DO NOTHING keeps the pre-existing grant, doesn't overwrite it.
    expect(rows[0].role).toBe('contributor');
  });

  test('deleteProject purges the project grant AND its threads grants (no orphans)', async () => {
    const pr = await import('../../services/project-repository.js');
    seedProject(t.db as any, { id: 'p1', userId: 'owner-1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'owner-1' });
    const g = grants();
    await g.upsertGrant({
      subjectId: 'ana',
      resourceType: 'project',
      resourceId: 'p1',
      role: 'admin',
      grantedBy: 'owner-1',
    });
    await g.upsertGrant({
      subjectId: 'bob',
      resourceType: 'thread',
      resourceId: 't1',
      role: 'contributor',
      grantedBy: 'owner-1',
    });

    await pr.deleteProject('p1');

    expect(await g.getGrantRole('ana', 'project', 'p1')).toBeNull();
    expect(await g.getGrantRole('bob', 'thread', 't1')).toBeNull();
  });

  test('authorizer over backfilled data: explicit grants only, NO inheritance (golden)', async () => {
    seedProject(t.db as any, { id: 'p1', userId: 'owner-1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'owner-1' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ana', role: 'member' });
    // ana also holds an explicit thread share (editor).
    t.db.run(
      sql`INSERT INTO thread_shares (thread_id, shared_with_user_id, shared_by_user_id, level, created_at)
          VALUES ('t1', 'ana', 'owner-1', 'steer', '2026-01-01')`,
    );
    t.db.run(
      sql`INSERT INTO team_projects (team_id, project_id, created_at) VALUES ('org-9', 'p1', '2026-01-01')`,
    );

    await backfill();
    const g = grants();

    const authz = createAuthorizer({
      getGrantRole: (s, type, id) => g.getGrantRole(s, type as any, id),
      getOrgRole: async () => null,
      loadThreadMeta: async (id) => {
        const r = t.db.all(sql`SELECT user_id FROM threads WHERE id = ${id}`) as any[];
        return r.length ? { ownerId: r[0].user_id } : null;
      },
      loadProjectMeta: async (id) => {
        const r = t.db.all(sql`SELECT user_id FROM projects WHERE id = ${id}`) as any[];
        return r.length ? { ownerId: r[0].user_id } : null;
      },
    });

    // ana's backfilled PROJECT grant works on the project…
    expect(await authz.authorize('ana', 'project', 'p1', 'view')).toBe(true);
    // …but project membership does NOT grant thread access — only her explicit
    // thread share (steer → contributor/editor) does.
    expect(await authz.effectiveRole('ana', 'thread', 't1')).toBe('contributor');
    expect(await authz.canCrossToOwnerRunner('ana', 't1')).toBe(true); // editor can steer
    // A user with ONLY a project grant (no thread share) sees nothing on the thread.
    await g.upsertGrant({
      subjectId: 'cy',
      resourceType: 'project',
      resourceId: 'p1',
      role: 'admin',
      grantedBy: 'owner-1',
    });
    expect(await authz.effectiveRole('cy', 'thread', 't1')).toBeNull();
    expect(await authz.authorize('cy', 'thread', 't1', 'view')).toBe(false);
    // A stranger gets nothing.
    expect(await authz.authorize('nobody', 'thread', 't1', 'view')).toBe(false);
  });
});
