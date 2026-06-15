/**
 * Thread privacy — access is EXPLICIT, no inheritance (unified-rbac-grants).
 *
 * A thread is private to its owner. Being a member of the owning project, or an
 * admin of the owning org, grants NOTHING on the thread — it must be shared
 * explicitly (viewer / commenter / editor). This guards the deliberate privacy
 * choice: org membership must never auto-expose other users' threads.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

const OWNER = 'owner-1';
const MEMBER = 'mem-2'; // project member, no explicit thread share
const ORG_ADMIN = 'orgadmin-3'; // admin of the org that owns the project
const ORG = 'org-7';

describe('thread privacy (no inheritance)', () => {
  let t: TestApp;
  let pm: typeof import('../../services/project-manager.js');

  beforeAll(async () => {
    t = await createTestApp();
    pm = await import('../../services/project-manager.js');
  });

  beforeEach(async () => {
    t.cleanup();
    t.db.run(sql`DELETE FROM member`);
    t.db.run(sql`DELETE FROM organization`);
    t.db.run(sql`DELETE FROM "user"`);
    t.db.run(
      sql`INSERT INTO organization (id, name, created_at) VALUES (${ORG}, 'Org Seven', '2026-01-01')`,
    );
    t.db.run(
      sql`INSERT INTO "user" (id, name, email, created_at, updated_at)
          VALUES (${ORG_ADMIN}, 'Org Admin', ${`${ORG_ADMIN}@x.test`}, '2026-01-01', '2026-01-01')`,
    );
    seedProject(t.db as any, { id: 'p1', userId: OWNER, organizationId: ORG });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: OWNER });
    t.db.run(
      sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
          VALUES ('m1', ${ORG}, ${ORG_ADMIN}, 'admin', '2026-01-01')`,
    );
    await pm.addMember('p1', MEMBER, 'admin'); // even project ADMIN, no thread access
  });

  test('a project member/admin canNOT read a thread without an explicit share', async () => {
    expect((await t.requestAs(MEMBER).get('/api/threads/t1')).status).toBe(404);
    expect((await t.requestAs(MEMBER).get('/api/threads/t1/messages')).status).toBe(404);
  });

  test('an org admin canNOT read the org project’s threads', async () => {
    expect((await t.requestAs(ORG_ADMIN).get('/api/threads/t1')).status).toBe(404);
  });

  test('the owner reads their own thread', async () => {
    expect((await t.requestAs(OWNER).get('/api/threads/t1')).status).toBe(200);
  });

  test('an explicit share is the only non-owner path in', async () => {
    // Share t1 with MEMBER as viewer → now they can read it.
    const res = await t.requestAs(OWNER).post('/api/threads/t1/shares', { userId: MEMBER });
    expect(res.status).toBe(201);
    expect((await t.requestAs(MEMBER).get('/api/threads/t1')).status).toBe(200);
  });
});
