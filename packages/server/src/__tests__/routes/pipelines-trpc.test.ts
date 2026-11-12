/**
 * The `pipelines` tRPC procedures (openspec adopt-trpc-browser-api, task 4.1):
 * tenant isolation, validation and parity with the REST routes, which serve the
 * same port while both paths coexist.
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
  });

  beforeEach(() => {
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

  test('reads return the same data on both paths', async () => {
    seedPipeline(t.db as any, { id: 'pl1', projectId: 'p1', userId: 'user-1', name: 'One' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    seedPipelineRun(t.db as any, { id: 'r1', pipelineId: 'pl1', threadId: 't1' });

    const rest = t.requestAs('user-1');
    const pairs: Array<[string, string, unknown]> = [
      ['/api/pipelines/project/p1', 'list', { projectId: 'p1' }],
      ['/api/pipelines/pl1', 'get', { id: 'pl1' }],
      ['/api/pipelines/runs/thread/t1', 'runsForThread', { threadId: 't1' }],
    ];
    for (const [restPath, procedure, input] of pairs) {
      const restRes = await rest.get(restPath);
      const trpcRes = await query('user-1', procedure, input);
      expect(trpcRes.status).toBe(restRes.status);
      expect(trpcRes.body.result.data).toEqual(await restRes.json());
    }

    const restMissing = await t.requestAs('user-2').get('/api/pipelines/pl1');
    const trpcMissing = await query('user-2', 'get', { id: 'pl1' });
    expect(trpcMissing.status).toBe(restMissing.status);
    expect(trpcMissing.body.error.message).toBe(((await restMissing.json()) as any).error);
  });
});
