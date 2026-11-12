/**
 * Personal API tokens (openspec public-rest-api-v1): a token authenticates the
 * public REST API as its owner, only there; revoked, expired, unknown and
 * malformed tokens are refused and audited; the plaintext is never stored or
 * listed.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import * as auditModule from '../../lib/audit.js';
import type { ServerEnv } from '../../lib/types.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject } from '../helpers/test-db.js';

const DAY = 24 * 60 * 60 * 1000;

describe('personal API tokens', () => {
  let t: TestApp;
  let api: Hono<ServerEnv>;
  let tokens: typeof import('../../services/personal-access-tokens.js');
  let audits: ReturnType<typeof spyOn>;

  const rejections = () =>
    audits.mock.calls
      .map(([entry]: any[]) => entry)
      .filter((entry: any) => entry.action === 'pat.rejected')
      .map((entry: any) => entry.meta.reason);

  const listProjects = async (authorization?: string) => {
    const res = await api.request('http://server/api/v1/projects', {
      headers: authorization ? { authorization } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const create = async (userId: string, days?: number, now?: Date) =>
    (await tokens.createPersonalAccessToken(userId, 'Chrome', days, now))._unsafeUnwrap();

  beforeAll(async () => {
    t = await createTestApp();
    tokens = await import('../../services/personal-access-tokens.js');
    const { mountPublicApi } = await import('../../public-api/mount.js');
    api = new Hono<ServerEnv>();
    mountPublicApi(api);
  });

  beforeEach(() => {
    t.cleanup();
    t.db.run(sql`DELETE FROM personal_access_tokens`);
    seedProject(t.db as any, { id: 'p1', userId: 'alice', name: 'Alpha', path: '/home/alice/p1' });
    audits = spyOn(auditModule, 'audit').mockImplementation(() => {});
  });

  afterEach(() => audits.mockRestore());

  test('a token authenticates the public API as its owner', async () => {
    const { token } = await create('alice');
    expect(token).toStartWith('funny_pat_');
    const { status, body } = await listProjects(`Bearer ${token}`);
    expect(status).toBe(200);
    expect(body.projects.map((p: any) => p.id)).toEqual(['p1']);
  });

  test('only the hash is stored; the list shows a prefix, never the token', async () => {
    const { token, info } = await create('alice');
    const rows = t.db.all(sql`SELECT * FROM personal_access_tokens`) as any[];
    expect(JSON.stringify(rows)).not.toContain(token);
    const listed = (await tokens.listPersonalAccessTokens('alice'))._unsafeUnwrap();
    expect(listed).toEqual([info]);
    expect(info.prefix).toBe(token.slice(0, 16));
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  test('no token is 401 and is not audited; a malformed or unknown one is audited', async () => {
    expect((await listProjects()).status).toBe(401);
    expect((await listProjects('Bearer not-a-funny-token')).status).toBe(401);
    expect((await listProjects('Bearer funny_pat_doesnotexist')).status).toBe(401);
    expect(rejections()).toEqual(['malformed', 'unknown']);
  });

  test('a revoked token is refused and audited', async () => {
    const { token, info } = await create('alice');
    expect((await tokens.revokePersonalAccessToken('alice', info.id))._unsafeUnwrap()).toBe(true);
    expect((await listProjects(`Bearer ${token}`)).status).toBe(401);
    expect(rejections()).toEqual(['revoked']);
  });

  test('an expired token is refused and audited', async () => {
    const { token } = await create('alice', 1, new Date(Date.now() - 2 * DAY));
    expect((await listProjects(`Bearer ${token}`)).status).toBe(401);
    expect(rejections()).toEqual(['expired']);
  });

  test("a user cannot revoke someone else's token", async () => {
    const { token, info } = await create('alice');
    expect((await tokens.revokePersonalAccessToken('mallory', info.id))._unsafeUnwrap()).toBe(
      false,
    );
    expect((await listProjects(`Bearer ${token}`)).status).toBe(200);
  });

  test('a lifetime is capped at a year', async () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const { info } = await create('alice', 10_000, now);
    expect(Date.parse(info.expiresAt) - now.getTime()).toBe(365 * DAY);
  });

  test('using a token records when it was last used', async () => {
    const { token, info } = await create('alice');
    await listProjects(`Bearer ${token}`);
    const [listed] = (await tokens.listPersonalAccessTokens('alice'))._unsafeUnwrap();
    expect(listed.id).toBe(info.id);
    expect(listed.lastUsedAt).toBeString();
  });
});

describe('the per-token rate limit', () => {
  test('a token owner over the limit gets 429 with Retry-After', async () => {
    await createTestApp();
    const { mountPublicApi } = await import('../../public-api/mount.js');
    const limited = new Hono<ServerEnv>();
    mountPublicApi(limited, async () => 'alice', { perTokenPerMinute: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await limited.request('http://server/api/v1/projects')).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const last = await limited.request('http://server/api/v1/projects');
    expect(last.headers.get('retry-after')).toBe('60');
  });
});

describe('a personal API token outside /api/v1', () => {
  test('is refused (401) and audited, never treated as a session', async () => {
    const { authMiddleware } = await import('../../middleware/auth.js');
    const app = new Hono<ServerEnv>();
    app.use('/api/*', authMiddleware);
    app.all('/api/*', (c) => c.json({ reached: true }));
    const audits = spyOn(auditModule, 'audit').mockImplementation(() => {});
    try {
      for (const path of ['/api/trpc/projects.list', '/api/threads/t1/stop', '/api/projects']) {
        const res = await app.request(`http://server${path}`, {
          method: path.endsWith('/stop') ? 'POST' : 'GET',
          headers: { authorization: 'Bearer funny_pat_anything' },
        });
        expect({ path, status: res.status }).toEqual({ path, status: 401 });
      }
      const reasons = audits.mock.calls
        .map(([entry]: any[]) => entry)
        .filter((entry: any) => entry.action === 'pat.rejected')
        .map((entry: any) => entry.meta.reason);
      expect(reasons).toEqual(['outside-public-api', 'outside-public-api', 'outside-public-api']);
    } finally {
      audits.mockRestore();
    }
  });
});
