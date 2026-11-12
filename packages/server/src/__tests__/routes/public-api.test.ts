/**
 * The public REST API v1 (openspec public-rest-api-v1): the OpenAPI document
 * lists exactly the published endpoints, nothing answers without a caller,
 * responses carry only the published fields, and a caller sees only their own
 * and shared projects. Personal API tokens come later; here the caller is
 * injected through `authenticate`.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

describe('public REST API v1', () => {
  let t: TestApp;
  let app: Hono<ServerEnv>;

  /** A request as the holder of a token for `userId` (no header: no token). */
  const get = async (path: string, userId?: string) => {
    const res = await app.request(`http://server/api/v1${path}`, {
      headers: userId ? { 'x-test-token-owner': userId } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
    const { mountPublicApi } = await import('../../public-api/mount.js');
    app = new Hono<ServerEnv>();
    mountPublicApi(app, async (c) => c.req.header('x-test-token-owner') ?? null);
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, {
      id: 'mine',
      userId: 'alice',
      name: 'Mine',
      path: '/home/alice/mine',
    });
    seedProject(t.db as any, {
      id: 'theirs',
      userId: 'bob',
      name: 'Theirs',
      path: '/home/bob/theirs',
    });
    seedProject(t.db as any, {
      id: 'bobs-shared',
      userId: 'bob',
      name: 'Shared',
      path: '/home/bob/s',
    });
    seedProjectMember(t.db as any, { projectId: 'bobs-shared', userId: 'alice', role: 'member' });
  });

  test('the OpenAPI document lists only the published endpoints, behind a bearer token', async () => {
    const { status, body } = await get('/openapi.json');
    expect(status).toBe(200);
    expect(body.openapi).toMatch(/^3\./);
    expect(Object.keys(body.paths).sort()).toEqual([
      '/models',
      '/projects',
      '/projects/resolve',
      '/threads',
    ]);
    expect(body.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(body.paths['/projects'].get.security).toEqual([{ bearerAuth: [] }]);
  });

  test('without a token every endpoint answers 401', async () => {
    expect((await get('/projects')).status).toBe(401);
    expect((await get('/projects/resolve?url=https://x.example')).status).toBe(401);
  });

  test('lists own and shared projects with the published fields only (never a path)', async () => {
    const { status, body } = await get('/projects', 'alice');
    expect(status).toBe(200);
    const byId = Object.fromEntries(body.projects.map((p: any) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['bobs-shared', 'mine']);
    expect(byId.mine).toEqual({ id: 'mine', name: 'Mine', shared: false });
    expect(byId['bobs-shared'].shared).toBe(true);
    expect(JSON.stringify(body)).not.toContain('/home/');
  });

  test("someone else's projects are never listed", async () => {
    const { body } = await get('/projects', 'carol');
    expect(body.projects).toEqual([]);
  });

  test('resolve matches a URL pattern of the caller’s projects', async () => {
    const { projectRepo } = { projectRepo: await import('../../services/project-repository.js') };
    await projectRepo.updateProject('mine', { urls: ['https://app.example.com'] });

    const hit = await get(
      `/projects/resolve?url=${encodeURIComponent('https://app.example.com/a')}`,
      'alice',
    );
    expect(hit.body).toEqual({
      project: { id: 'mine', name: 'Mine', urls: ['https://app.example.com'], shared: false },
      source: 'url_match',
    });

    const miss = await get(
      `/projects/resolve?url=${encodeURIComponent('https://app.example.com/a')}`,
      'bob',
    );
    expect(miss.body).toEqual({ project: null, source: 'none' });
  });

  test('an unpublished path answers 404, including the web client’s procedures', async () => {
    expect((await get('/threads.list', 'alice')).status).toBe(404);
    expect((await get('/trpc/projects.list', 'alice')).status).toBe(404);
    expect((await get('/nope', 'alice')).status).toBe(404);
  });

  test('every public procedure is published under a path and declares its output', async () => {
    const { publicV1Router } = await import('../../public-api/router.js');
    const procedures = Object.entries(publicV1Router._def.procedures);
    expect(procedures.length).toBeGreaterThan(0);
    for (const [name, procedure] of procedures) {
      const def = (procedure as any)._def;
      expect({ name, path: def.meta?.openapi?.path }).toMatchObject({
        path: expect.stringMatching(/^\//),
      });
      // An output parser strips every field the published schema does not declare.
      expect({ name, hasOutput: typeof def.output === 'function' || !!def.output }).toEqual({
        name,
        hasOutput: true,
      });
    }
  });
});
