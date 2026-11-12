/**
 * The `personalTokens` tRPC procedures (openspec public-rest-api-v1, task 2.3):
 * a user lists, creates and revokes only their own tokens, the plaintext is
 * answered once by `create` and never listed, and bad input is a 400.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('personal tokens over tRPC', () => {
  let t: TestApp;

  const query = async (userId: string, path: string) => {
    const res = await t.app.request(`/api/trpc/${path}`, { headers: headersFor(userId) });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/${path}`, {
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
    t.db.run(sql`DELETE FROM personal_access_tokens`);
  });

  test('create answers the token once; list shows it without the plaintext', async () => {
    const created = await mutate('alice', 'personalTokens.create', { name: 'CI', days: 30 });
    expect(created.status).toBe(200);
    const { token, info } = created.body.result.data;
    expect(token).toStartWith('funny_pat_');
    expect(token.startsWith(info.prefix)).toBe(true);
    expect(info.name).toBe('CI');
    const lifetime = Date.parse(info.expiresAt) - Date.parse(info.createdAt);
    expect(lifetime).toBe(30 * 24 * 60 * 60 * 1000);

    const listed = await query('alice', 'personalTokens.list');
    expect(listed.status).toBe(200);
    expect(listed.body.result.data).toEqual([info]);
    expect(JSON.stringify(listed.body)).not.toContain(token);
  });

  test('a user sees only their own tokens', async () => {
    await mutate('alice', 'personalTokens.create', { name: 'Alice token' });
    await mutate('bob', 'personalTokens.create', { name: 'Bob token' });

    const listed = await query('alice', 'personalTokens.list');
    expect(listed.body.result.data.map((i: any) => i.name)).toEqual(['Alice token']);
  });

  test('revoke marks the caller token revoked; someone else or a second revoke is 404', async () => {
    const created = await mutate('alice', 'personalTokens.create', { name: 'CI' });
    const id = created.body.result.data.info.id;

    expect((await mutate('bob', 'personalTokens.revoke', { id })).status).toBe(404);
    const untouched = await query('alice', 'personalTokens.list');
    expect(untouched.body.result.data[0].revokedAt).toBeUndefined();

    const revoked = await mutate('alice', 'personalTokens.revoke', { id });
    expect(revoked.status).toBe(200);
    expect(revoked.body.result.data).toEqual({ ok: true });
    const listed = await query('alice', 'personalTokens.list');
    expect(listed.body.result.data[0].revokedAt).toBeString();

    expect((await mutate('alice', 'personalTokens.revoke', { id })).status).toBe(404);
  });

  test('bad input is 400', async () => {
    for (const input of [
      { name: '' },
      { name: 'x'.repeat(65) },
      { name: 'CI', days: 0 },
      { name: 'CI', days: 366 },
      { name: 'CI', days: 1.5 },
      { name: 'CI', extra: true },
    ]) {
      expect((await mutate('alice', 'personalTokens.create', input)).status).toBe(400);
    }
    expect((await mutate('alice', 'personalTokens.revoke', {})).status).toBe(400);
  });
});
