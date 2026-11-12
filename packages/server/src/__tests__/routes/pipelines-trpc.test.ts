/**
 * The `pipelines` tRPC procedures (openspec adopt-trpc-browser-api, task 4.1):
 * tenant isolation and validation, and the removed REST CRUD routes, which must
 * answer 404 instead of reaching a runner while the approval gates stay REST.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedPipeline, seedPipelineRun, seedProject, seedThread } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('pipelines tRPC procedures', () => {
  let t: TestApp;
  let proxied: string[];

  const query = async (userId: string, path: string, input: unknown) => {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/pipelines.${path}${qs}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/pipelines.${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
    // Stands in for the runner proxy catch-all, registered after every route.
    t.app.all('/api/*', (c) => {
      proxied.push(c.req.path);
      return c.json({ proxied: true }, 599 as never);
    });
  });

  beforeEach(() => {
    proxied = [];
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedProject(t.db as any, { id: 'p2', userId: 'user-2', path: '/tmp/p2' });
  });

  test('create, update, list and remove', async () => {
    const created = await mutate('user-1', 'create', {
      projectId: 'p1',
      name: 'Review',
      maxIterations: 5,
    });
    expect(created.status).toBe(200);
    const pipeline = created.body.result.data;
    expect(pipeline).toMatchObject({ name: 'Review', userId: 'user-1', maxIterations: 5 });

    const updated = await mutate('user-1', 'update', {
      id: pipeline.id,
      data: { enabled: false, reviewerPrompt: '' },
    });
    expect(updated.body.result.data.enabled).toBe(false);
    expect(updated.body.result.data.reviewerPrompt).toBeUndefined();

    const listed = await query('user-1', 'list', { projectId: 'p1' });
    expect(listed.body.result.data.map((p: any) => p.id)).toEqual([pipeline.id]);

    expect((await mutate('user-1', 'remove', { id: pipeline.id })).body.result.data).toEqual({
      ok: true,
    });
    expect((await query('user-1', 'get', { id: pipeline.id })).status).toBe(404);
  });

  test('another user’s pipeline looks absent (404) on every procedure', async () => {
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1' });

    expect((await query('user-2', 'get', { id: 'pl1' })).status).toBe(404);
    expect((await mutate('user-2', 'update', { id: 'pl1', data: { name: 'x' } })).status).toBe(404);
    expect((await mutate('user-2', 'remove', { id: 'pl1' })).status).toBe(404);
    expect((await query('user-2', 'list', { projectId: 'p1' })).body.result.data).toEqual([]);
  });

  test('creating on a project the user cannot see answers 404', async () => {
    const res = await mutate('user-1', 'create', { projectId: 'p2', name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Project not found');
  });

  test('invalid input answers 400 with the REST message', async () => {
    const res = await mutate('user-1', 'create', { projectId: 'p1' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('projectId and name are required');

    const typed = await mutate('user-1', 'create', {
      projectId: 'p1',
      name: 'x',
      maxIterations: 'many',
    });
    expect(typed.status).toBe(400);
  });

  test('runs of another user’s thread come back empty', async () => {
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    seedPipelineRun(t.db as any, { id: 'r1', pipelineId: 'pl1', threadId: 't1' });

    expect(
      (await query('user-1', 'runsForThread', { threadId: 't1' })).body.result.data,
    ).toHaveLength(1);
    expect((await query('user-2', 'runsForThread', { threadId: 't1' })).body.result.data).toEqual(
      [],
    );
  });

  test('a cross-tenant update or remove leaves the row untouched', async () => {
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1', name: 'Mine' });
    await mutate('user-2', 'update', { id: 'pl1', data: { name: 'Hijacked' } });
    await mutate('user-2', 'remove', { id: 'pl1' });
    expect((await query('user-1', 'get', { id: 'pl1' })).body.result.data.name).toBe('Mine');
  });

  test('update answers 404 for a missing pipeline and 400 for a wrong field type', async () => {
    expect((await mutate('user-1', 'update', { id: 'missing', data: { name: 'x' } })).status).toBe(
      404,
    );
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1' });
    const res = await mutate('user-1', 'update', { id: 'pl1', data: { enabled: 'false' } });
    expect(res.status).toBe(400);
  });

  test('responses are the contract types, not raw rows', async () => {
    seedPipeline(t.db as any, {
      id: 'pl1',
      projectId: 'p1',
      userId: 'user-1',
      enabled: 1,
      precommitFixEnabled: 0,
      testEnabled: 1,
      testFixEnabled: 0,
    });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    seedThread(t.db as any, { id: 't-review', projectId: 'p1', userId: 'user-1' });
    seedPipelineRun(t.db as any, {
      id: 'r1',
      pipelineId: 'pl1',
      threadId: 't1',
      reviewerThreadId: 't-review',
    });

    const [pipeline] = (await query('user-1', 'list', { projectId: 'p1' })).body.result.data;
    expect(pipeline).toMatchObject({
      enabled: true,
      precommitFixEnabled: false,
      testEnabled: true,
      testFixEnabled: false,
    });
    expect(pipeline).not.toHaveProperty('reviewerPrompt');
    expect(Object.values(pipeline)).not.toContain(null);

    const [run] = (await query('user-1', 'runsForThread', { threadId: 't1' })).body.result.data;
    expect(run).toMatchObject({ id: 'r1', reviewerThreadId: 't-review' });
    expect(run).not.toHaveProperty('verdict');
    expect(Object.values(run)).not.toContain(null);
  });

  test('the former CRUD routes answer 404 without reaching a runner', async () => {
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1' });
    const requests: Array<[string, string]> = [
      ['GET', '/api/pipelines/project/p1'],
      ['GET', '/api/pipelines/pl1'],
      ['POST', '/api/pipelines'],
      ['PATCH', '/api/pipelines/pl1'],
      ['DELETE', '/api/pipelines/pl1'],
      ['GET', '/api/pipelines/runs/thread/t1'],
    ];
    for (const [method, path] of requests) {
      const res = await t.app.request(path, {
        method,
        headers: headersFor('user-1'),
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    expect(proxied).toEqual([]);
    expect((await query('user-1', 'get', { id: 'pl1' })).status).toBe(200);
  });

  test('the approval gates still go to the runner proxy (502 here: no runner)', async () => {
    const respond = await t.app.request('/api/pipelines/approvals/unknown/respond', {
      method: 'POST',
      headers: headersFor('user-1'),
      body: JSON.stringify({ decision: 'approve' }),
    });
    const pending = await t.app.request('/api/pipelines/approvals/pending', {
      headers: headersFor('user-1'),
    });
    for (const res of [respond, pending]) {
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).code).toBe('general-runner-offline');
    }
  });
});
