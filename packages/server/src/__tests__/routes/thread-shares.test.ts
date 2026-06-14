/**
 * Integration tests for thread sharing (server-owned share grants).
 *
 * Covers the share admin API (create/list/revoke), project-membership gating, and
 * the end-to-end effect of a grant: a sharee can read + comment but is 404 on
 * mutation. Runner-proxied routes (follow-up/start/stop) are not exercised here.
 */

import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => false,
  relayToUser: () => {},
  broadcast: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
  threadStreamRoom: (id: string) => `thread:${id}:stream`,
  threadPresenceRoom: (id: string) => `thread:${id}:presence`,
  relayToThreadStream: () => {},
  relayToThreadPresence: () => {},
  evictUserFromThread: () => {},
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch: () => Promise.reject(new Error('not available in test')),
  isTunnelTimeoutError: () => false,
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember, seedThread } from '../helpers/test-db.js';

const OWNER = 'owner-1';
const ANA = 'ana-2'; // member of the thread's project (p1)
const BOB = 'bob-3'; // NOT a member of the project
const ORG = 'org-1';

/** Seed the better-auth identity rows the share routes read (raw SQL avoids
 *  drizzle date-mode friction on these tables). */
function seedIdentity(t: TestApp) {
  const now = new Date().toISOString();
  for (const [id, name] of [
    [OWNER, 'Owner'],
    [ANA, 'Ana'],
    [BOB, 'Bob'],
  ]) {
    t.db.run(
      sql`INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at)
          VALUES (${id}, ${name}, ${`${id}@x.test`}, 0, ${`https://img/${id}.png`}, ${now}, ${now})`,
    );
  }
  t.db.run(
    sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${ORG}, 'Org', 'org', ${now})`,
  );
  // Owner and Ana are in ORG; Bob is not.
  for (const uid of [OWNER, ANA]) {
    t.db.run(
      sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
          VALUES (${`m-${uid}`}, ${ORG}, ${uid}, 'member', ${now})`,
    );
  }
}

describe('Thread sharing (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    t.db.run(sql`DELETE FROM thread_shares`);
    t.db.run(sql`DELETE FROM member`);
    t.db.run(sql`DELETE FROM organization`);
    t.db.run(sql`DELETE FROM "user"`);
    seedProject(t.db as any, { id: 'p1', userId: OWNER, path: '/a' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: OWNER });
    // Owner + Ana are members of the thread's project; Bob is not.
    seedProjectMember(t.db as any, { projectId: 'p1', userId: OWNER, role: 'admin' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: ANA });
    seedIdentity(t);
  });

  // ── POST /:id/shares ───────────────────────────────────

  test('owner shares a thread with a project member (201)', async () => {
    const res = await t.requestAs(OWNER, 'user', { orgId: ORG }).post('/api/threads/t1/shares', {
      userId: ANA,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ threadId: 't1', sharedWithUserId: ANA, sharedByUserId: OWNER });
  });

  test('re-sharing the same pair is idempotent (200)', async () => {
    await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .post('/api/threads/t1/shares', { userId: ANA });
    const res = await t.requestAs(OWNER, 'user', { orgId: ORG }).post('/api/threads/t1/shares', {
      userId: ANA,
    });
    expect(res.status).toBe(200);
  });

  test('sharing with a non-project user is rejected (400)', async () => {
    const res = await t.requestAs(OWNER, 'user', { orgId: ORG }).post('/api/threads/t1/shares', {
      userId: BOB,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('share-target-not-in-project');
  });

  test('sharing with yourself is rejected (400)', async () => {
    const res = await t.requestAs(OWNER, 'user', { orgId: ORG }).post('/api/threads/t1/shares', {
      userId: OWNER,
    });
    expect(res.status).toBe(400);
  });

  test('sharing a project member works without an active organization (201)', async () => {
    // Project membership — not org membership — gates sharing now.
    const res = await t.requestAs(OWNER).post('/api/threads/t1/shares', { userId: ANA });
    expect(res.status).toBe(201);
  });

  test('a non-owner cannot create a share (404, owner-only)', async () => {
    const res = await t.requestAs(ANA, 'user', { orgId: ORG }).post('/api/threads/t1/shares', {
      userId: BOB,
    });
    expect(res.status).toBe(404);
  });

  // ── GET /:id/shares ────────────────────────────────────

  test('owner lists shares with invited-user display info', async () => {
    await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .post('/api/threads/t1/shares', { userId: ANA });

    const res = await t.requestAs(OWNER, 'user', { orgId: ORG }).get('/api/threads/t1/shares');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ sharedWithUserId: ANA, user: { id: ANA, name: 'Ana' } });
  });

  // ── DELETE /:id/shares/:userId ─────────────────────────

  test('owner revokes a share; the user loses read access', async () => {
    await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .post('/api/threads/t1/shares', { userId: ANA });
    expect((await t.requestAs(ANA).get('/api/threads/t1')).status).toBe(200);

    const del = await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .delete(`/api/threads/t1/shares/${ANA}`);
    expect(del.status).toBe(200);

    expect((await t.requestAs(ANA).get('/api/threads/t1')).status).toBe(404);
  });

  // ── End-to-end effect of a grant ───────────────────────

  test('a sharee can read and comment but is 404 on mutation', async () => {
    await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .post('/api/threads/t1/shares', { userId: ANA });

    // Read: detail + messages + events
    expect((await t.requestAs(ANA).get('/api/threads/t1')).status).toBe(200);
    expect((await t.requestAs(ANA).get('/api/threads/t1/messages')).status).toBe(200);
    expect((await t.requestAs(ANA).get('/api/threads/t1/events')).status).toBe(200);

    // Comment: allowed
    const comment = await t.requestAs(ANA).post('/api/threads/t1/comments', { content: 'nice' });
    expect(comment.status).toBe(201);

    // Mutation: forbidden (owner-only) — indistinguishable 404
    expect((await t.requestAs(ANA).patch('/api/threads/t1', { title: 'hijack' })).status).toBe(404);
    expect((await t.requestAs(ANA).delete('/api/threads/t1')).status).toBe(404);
  });

  test('a stranger (no grant) cannot read the thread (404)', async () => {
    expect((await t.requestAs(BOB).get('/api/threads/t1')).status).toBe(404);
  });

  // ── GET /shared-with-me ────────────────────────────────

  test('shared-with-me lists threads shared TO the caller', async () => {
    await t
      .requestAs(OWNER, 'user', { orgId: ORG })
      .post('/api/threads/t1/shares', { userId: ANA });

    const res = await t.requestAs(ANA).get('/api/threads/shared-with-me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].id).toBe('t1');

    // The owner has nothing shared TO them.
    const ownerView = await t.requestAs(OWNER).get('/api/threads/shared-with-me');
    expect((await ownerView.json()).threads).toHaveLength(0);
  });
});
