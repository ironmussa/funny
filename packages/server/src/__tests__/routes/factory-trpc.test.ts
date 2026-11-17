/**
 * The `factory` tRPC procedures (change issue-factory; the REST `/api/factory`
 * routes were retired): the caller's own settings per project, the role a save
 * needs, input validation and the run list.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

describe('factory over tRPC', () => {
  let t: TestApp;

  const headersFor = (userId: string) => ({
    'X-Test-User-Id': userId,
    'Content-Type': 'application/json',
  });

  const query = async (userId: string, path: string, input: unknown) => {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/factory.${path}${qs}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: ((await res.json()) as any).result?.data };
  };

  const save = async (userId: string, input: unknown) => {
    const res = await t.app.request('/api/trpc/factory.save', {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: ((await res.json()) as any).result?.data };
  };

  beforeAll(async () => {
    t = await createTestApp({ userId: 'alice' });
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'alice', path: '/repo-a' });
    seedProject(t.db as any, { id: 'bob-project', userId: 'bob', path: '/repo-b' });
  });

  test('settings are null until saved, then read back', async () => {
    expect(await query('alice', 'settings', { projectId: 'p1' })).toEqual({
      status: 200,
      body: null,
    });

    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      label: 'ready',
      maxConcurrent: 3,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, label: 'ready', maxConcurrent: 3 });

    const read = await query('alice', 'settings', { projectId: 'p1' });
    expect(read.body).toMatchObject({ enabled: true, label: 'ready' });
  });

  test('runs is empty until a factory exists, then lists none', async () => {
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toEqual([]);
    await save('alice', { projectId: 'p1', enabled: true });
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toEqual([]);
  });

  test('a contributor may save; a viewer may read but not save; an outsider gets 404', async () => {
    seedProjectMember(t.db as any, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    seedProjectMember(t.db as any, { projectId: 'bob-project', userId: 'vic', role: 'viewer' });

    expect((await save('alice', { projectId: 'bob-project', enabled: true })).status).toBe(200);
    expect((await query('vic', 'settings', { projectId: 'bob-project' })).status).toBe(200);
    expect((await save('vic', { projectId: 'bob-project', enabled: true })).status).toBe(403);
    expect((await save('carol', { projectId: 'p1', enabled: true })).status).toBe(404);
    expect((await query('carol', 'settings', { projectId: 'p1' })).status).toBe(404);
  });

  test('refuses a malformed input, a path-like flow name and a label with a comma', async () => {
    expect((await save('alice', { projectId: 'p1' })).status).toBe(400);
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, maxConcurrent: 99 })).status,
    ).toBe(400);
    expect((await save('alice', { projectId: 'p1', enabled: true, label: '' })).status).toBe(400);
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, flowName: '../secrets' })).status,
    ).toBe(400);
    expect((await save('alice', { projectId: 'p1', enabled: true, label: 'a,b' })).status).toBe(
      400,
    );
  });

  test('the retired REST path answers 404 instead of reaching a runner', async () => {
    const res = await t.app.request('/api/factory/projects/p1', { headers: headersFor('alice') });
    expect(res.status).toBe(404);
  });

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/factory.${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: ((await res.json()) as any).result?.data };
  };

  async function seededRun(state: string) {
    await save('alice', { projectId: 'p1', enabled: false });
    const { createFactorySettingsService } =
      await import('../../services/factory/factory-settings.js');
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const factoryId = (
      await createFactorySettingsService().factoryId('alice', 'p1')
    )._unsafeUnwrap()!;
    return (
      await createFactoryRunsRepository().start({ factoryId, issueNumber: 7, state: state as any })
    )._unsafeUnwrap();
  }

  test('the owner stops a run in flight and retries a failed one', async () => {
    const running = await seededRun('working');
    const stopped = await mutate('alice', 'stopRun', { projectId: 'p1', runId: running.id });
    expect(stopped).toMatchObject({ status: 200, body: { state: 'stopped' } });
    // A stopped run has ended: neither stop nor retry applies.
    expect((await mutate('alice', 'stopRun', { projectId: 'p1', runId: running.id })).status).toBe(
      409,
    );
    expect((await mutate('alice', 'retryRun', { projectId: 'p1', runId: running.id })).status).toBe(
      409,
    );

    const failed = await seededRun('failed');
    const retried = await mutate('alice', 'retryRun', { projectId: 'p1', runId: failed.id });
    expect(retried).toMatchObject({ status: 200, body: { state: 'queued' } });
  });

  test("another user's run is not found, and a viewer cannot control runs", async () => {
    const run = await seededRun('working');
    expect((await mutate('bob', 'stopRun', { projectId: 'p1', runId: run.id })).status).toBe(404);
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'stopRun', { projectId: 'p1', runId: run.id })).status).toBe(403);
    expect((await mutate('alice', 'stopRun', { projectId: 'p1', runId: 'nope' })).status).toBe(404);
  });
});
