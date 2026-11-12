/**
 * `POST /api/v1/threads` and `GET /api/v1/models` (openspec public-rest-api-v1,
 * tasks 3.2 / 3.3). Creation runs the shared creation use case against the
 * real runner resolution with fake transport / presence ports: it must reach
 * only the caller's own runner, signed as the caller, and never fall back.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { deriveRunnerForwardingKey } from '@funny/shared/auth/runner-keys';
import { PUBLIC_IMAGE_MAX_BYTES } from '@funny/shared/contracts/public-v1';
import { MODEL_REGISTRY } from '@funny/shared/models';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import type { RunnerPresencePort, RunnerRequest } from '../../services/runner-ports.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  seedProject,
  seedProjectMember,
  seedRunner,
  seedRunnerProjectAssignment,
} from '../helpers/test-db.js';

const RUNNER_OWNER: Record<string, string> = { 'r-alice': 'alice', 'r-bob': 'bob' };

/** Fake runner transport: records every request, answers like a runner that created `t-new`. */
function fakeRunners(online: string[]) {
  const sent: Array<{ runnerId: string; request: RunnerRequest }> = [];
  const runnerPresence = {
    isAvailable: async (id: string) => online.includes(id),
    userHasAvailableRunner: async (uid: string) => online.some((id) => RUNNER_OWNER[id] === uid),
    userIdForRunner: async (id: string) => RUNNER_OWNER[id] ?? null,
    availableRunnerCount: async () => online.length,
  } as RunnerPresencePort;
  const runnerRequests = {
    isAvailable: async (id: string) => online.includes(id),
    request: async (runnerId: string, request: RunnerRequest) => {
      sent.push({ runnerId, request });
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({ id: 't-new', title: 'From runner', internalPath: '/secret' }),
      };
    },
  };
  return { sent, env: { runnerRequests, runnerPresence } };
}

const PNG = 'iVBORw0KGgo='; // 8 bytes of a PNG header, base64

describe('public REST API v1: threads and models', () => {
  let t: TestApp;
  let app: Hono<ServerEnv>;

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    { userId, body, env }: { userId?: string; body?: unknown; env?: object } = {},
  ) => {
    const res = await app.request(
      `http://server/api/v1${path}`,
      {
        method,
        headers: {
          ...(userId ? { 'x-test-token-owner': userId } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  const create = (userId: string, body: Record<string, unknown>, online = ['r-alice', 'r-bob']) => {
    const runners = fakeRunners(online);
    return call('POST', '/threads', { userId, body, env: runners.env }).then((res) => ({
      ...res,
      sent: runners.sent,
    }));
  };

  const sentBody = (sent: Array<{ request: RunnerRequest }>) =>
    JSON.parse(sent[0].request.body as string);

  beforeAll(async () => {
    t = await createTestApp();
    const { mountPublicApi } = await import('../../public-api/mount.js');
    app = new Hono<ServerEnv>();
    mountPublicApi(app, async (c) => c.req.header('x-test-token-owner') ?? null);
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p-alice', userId: 'alice', name: 'A', path: '/home/alice/a' });
    seedProject(t.db as any, { id: 'p-bob', userId: 'bob', name: 'B', path: '/home/bob/b' });
    seedProjectMember(t.db as any, { projectId: 'p-bob', userId: 'carol', role: 'viewer' });
    seedRunner(t.db as any, { id: 'r-alice', userId: 'alice', token: 'tok-a' });
    seedRunner(t.db as any, { id: 'r-bob', userId: 'bob', token: 'tok-b' });
    seedRunnerProjectAssignment(t.db as any, { runnerId: 'r-alice', projectId: 'p-alice' });
    seedRunnerProjectAssignment(t.db as any, { runnerId: 'r-bob', projectId: 'p-bob' });
  });

  test('the OpenAPI document publishes POST /threads and GET /models', async () => {
    const { body } = await call('GET', '/openapi.json');
    expect(body.paths['/threads'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(body.paths['/models'].get.security).toEqual([{ bearerAuth: [] }]);
  });

  test('creates the thread on the caller’s own runner, signed as the caller', async () => {
    const { status, body, sent } = await create('alice', { projectId: 'p-alice', prompt: 'hi' });

    expect(status).toBe(200);
    expect(sent.map((s) => s.runnerId)).toEqual(['r-alice']);
    expect(sent[0].request.path).toBe('/api/threads');
    const h = sent[0].request.headers;
    expect(h['X-Forwarded-User']).toBe('alice');
    expect(
      verifyForwardedIdentity(
        { userId: 'alice', role: 'user', orgId: null, orgName: null },
        deriveRunnerForwardingKey('test-secret', 'r-alice'),
        h[SIGNATURE_HEADER],
        h[TIMESTAMP_HEADER],
        h[NONCE_HEADER],
      ),
    ).toBe(true);

    // Published fields only, from the row the server registered.
    expect(Object.keys(body.thread).sort()).toEqual([
      'createdAt',
      'id',
      'projectId',
      'status',
      'title',
    ]);
    expect(body.thread).toMatchObject({ id: 't-new', projectId: 'p-alice', title: 'From runner' });
    expect(JSON.stringify(body)).not.toContain('/secret');
    const row = await t.db.query.threads.findFirst({ where: (th, { eq }) => eq(th.id, 't-new') });
    expect(row?.userId).toBe('alice');
    expect(row?.runnerId).toBe('r-alice');
  });

  test('sends only the declared fields, with a safe default mode and source `api`', async () => {
    const { sent } = await create('alice', {
      projectId: 'p-alice',
      prompt: 'hi',
      worktreePath: '/etc',
      disallowedTools: [],
      isScratch: true,
    });
    expect(sentBody(sent)).toEqual({
      projectId: 'p-alice',
      prompt: 'hi',
      mode: 'local',
      permissionMode: 'ask',
      source: 'api',
    });
  });

  test('records `chrome_extension` when the extension says it is calling', async () => {
    const { sent } = await create('alice', {
      projectId: 'p-alice',
      prompt: 'hi',
      client: 'chrome_extension',
    });
    expect(sentBody(sent).source).toBe('chrome_extension');
  });

  test('refuses the modes that act without asking', async () => {
    for (const permissionMode of ['autoEdit', 'auto', 'bypassPermissions']) {
      const { status, sent } = await create('alice', {
        projectId: 'p-alice',
        prompt: 'hi',
        permissionMode,
      });
      expect({ permissionMode, status }).toEqual({ permissionMode, status: 400 });
      expect(sent).toEqual([]);
    }
    const { sent } = await create('alice', {
      projectId: 'p-alice',
      prompt: 'hi',
      permissionMode: 'plan',
    });
    expect(sentBody(sent).permissionMode).toBe('plan');
  });

  test('passes images in the runner’s attachment shape', async () => {
    const { status, sent } = await create('alice', {
      projectId: 'p-alice',
      prompt: 'look',
      images: [{ mediaType: 'image/png', data: PNG }],
    });
    expect(status).toBe(200);
    expect(sentBody(sent).images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
  });

  test('an image over 5 MB, a non-base64 image, or too many images answer 400', async () => {
    const tooBig = 'A'.repeat(Math.ceil((PUBLIC_IMAGE_MAX_BYTES + 3) / 3) * 4);
    for (const images of [
      [{ mediaType: 'image/png', data: tooBig }],
      [{ mediaType: 'image/png', data: 'not base64!' }],
      [{ mediaType: 'image/gif', data: PNG }],
      Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PNG })),
    ]) {
      const { status, sent } = await create('alice', { projectId: 'p-alice', prompt: 'x', images });
      expect({ image: images[0].data.slice(0, 12), status }).toEqual({
        image: images[0].data.slice(0, 12),
        status: 400,
      });
      expect(sent).toEqual([]);
    }
  });

  test('validates the model against the registry', async () => {
    const bad = await create('alice', { projectId: 'p-alice', prompt: 'x', model: 'toString' });
    expect(bad.status).toBe(400);
    const wrongProvider = await create('alice', {
      projectId: 'p-alice',
      prompt: 'x',
      provider: 'codex',
      model: 'haiku',
    });
    expect(wrongProvider.status).toBe(400);
    const good = await create('alice', { projectId: 'p-alice', prompt: 'x', model: 'haiku' });
    expect(good.status).toBe(200);
    expect(sentBody(good.sent).model).toBe('haiku');
  });

  test('bad input answers 400 before any runner is contacted', async () => {
    for (const body of [
      { projectId: 'p-alice' },
      { projectId: 'p-alice', prompt: '' },
      { projectId: 'p-alice', prompt: 'x'.repeat(100_001) },
      { projectId: 'p-alice', prompt: 'x', title: 't'.repeat(201) },
      { projectId: 'p-alice', prompt: 'x', mode: 'sandbox' },
    ]) {
      const { status, sent } = await create('alice', body);
      expect({ keys: Object.keys(body), status }).toEqual({ keys: Object.keys(body), status: 400 });
      expect(sent).toEqual([]);
    }
  });

  test("the caller's runner offline answers 502 and no other runner is contacted", async () => {
    const { status, sent } = await create('alice', { projectId: 'p-alice', prompt: 'hi' }, [
      'r-bob',
    ]);
    expect(status).toBe(502);
    expect(sent).toEqual([]);
  });

  test("someone else's project answers 404 and nothing is created", async () => {
    const { status, sent } = await create('alice', { projectId: 'p-bob', prompt: 'hi' });
    expect(status).toBe(404);
    expect(sent).toEqual([]);
    const missing = await create('alice', { projectId: 'nope', prompt: 'hi' });
    expect(missing.status).toBe(404);
    const rows = await t.db.query.threads.findMany();
    expect(rows).toEqual([]);
  });

  test('a viewer of the project cannot create threads in it (403)', async () => {
    const { status, sent } = await create('carol', { projectId: 'p-bob', prompt: 'hi' });
    expect(status).toBe(403);
    expect(sent).toEqual([]);
  });

  test('without a token creation answers 401', async () => {
    const runners = fakeRunners(['r-alice']);
    const { status } = await call('POST', '/threads', {
      body: { projectId: 'p-alice', prompt: 'hi' },
      env: runners.env,
    });
    expect(status).toBe(401);
    expect(runners.sent).toEqual([]);
  });

  test('lists the registry’s providers and models with their defaults', async () => {
    const { status, body } = await call('GET', '/models', { userId: 'alice' });
    expect(status).toBe(200);
    expect(body.defaultProvider).toBe('claude');
    expect(body.providers.map((p: any) => p.id).sort()).toEqual(Object.keys(MODEL_REGISTRY).sort());
    const claude = body.providers.find((p: any) => p.id === 'claude');
    expect(claude.name).toBe('Claude');
    expect(claude.models).toContainEqual({ id: 'haiku', name: 'Haiku 4.5' });
    expect(claude.models.map((m: any) => m.id)).toContain(claude.defaultModel);
    expect(Object.keys(claude.models[0]).sort()).toEqual(['id', 'name']);
    expect((await call('GET', '/models')).status).toBe(401);
  });
});
