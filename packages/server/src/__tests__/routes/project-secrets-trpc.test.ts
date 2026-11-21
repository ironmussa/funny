/**
 * The `projectSecrets` tRPC procedures (openspec project-secrets): the role
 * each scope needs, 404 without a role, personal rows kept to their owner,
 * input validation, and no answer carrying a value.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';
process.env.FUNNY_ENCRYPTION_KEYS = JSON.stringify({ active: 'k1', keys: { k1: 'ab'.repeat(32) } });

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

const VALUE = 'value-that-must-not-come-back';

describe('project secrets over tRPC', () => {
  let t: TestApp;

  const headersFor = (userId: string) => ({
    'X-Test-User-Id': userId,
    'Content-Type': 'application/json',
  });

  const list = async (userId: string, projectId = 'p1') => {
    const qs = `?input=${encodeURIComponent(JSON.stringify({ projectId }))}`;
    const res = await t.app.request(`/api/trpc/projectSecrets.list${qs}`, {
      headers: headersFor(userId),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text).result?.data };
  };

  const mutate = async (userId: string, procedure: 'set' | 'delete', input: unknown) => {
    const res = await t.app.request(`/api/trpc/projectSecrets.${procedure}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text).result?.data };
  };

  const secret = (
    scope: 'project' | 'user',
    name: string,
    extra: { value?: string; extra?: number } = {},
  ) => ({
    projectId: 'p1',
    scope,
    name,
    value: VALUE,
    allowInSandbox: false,
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestApp({ userId: 'alice' });
  });

  beforeEach(() => {
    t.cleanup();
    t.db.run(sql`DELETE FROM project_secrets`);
    // alice owns p1; bob is an admin, carol a contributor, dave a viewer.
    seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo-a' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'bob', role: 'admin' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'carol', role: 'member' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'dave', role: 'viewer' });
  });

  test('a saved secret is listed with its settings and never its value', async () => {
    const saved = await mutate('alice', 'set', secret('project', 'API_KEY'));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'API_KEY', scope: 'project', allowInSandbox: false });
    expect(saved.text).not.toContain(VALUE);

    const listed = await list('alice');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([saved.body]);
    expect(listed.text).not.toContain(VALUE);
    expect(Object.keys(listed.body[0]).sort()).toEqual([
      'allowInSandbox',
      'id',
      'name',
      'scope',
      'updatedAt',
      'updatedBy',
    ]);

    const [row] = t.db.all<{ ciphertext: string }>(sql`SELECT ciphertext FROM project_secrets`);
    expect(row.ciphertext).not.toContain(VALUE);
  });

  test('the sandbox setting changes without sending the value again', async () => {
    await mutate('alice', 'set', secret('project', 'API_KEY'));
    const before = t.db.all<{ ciphertext: string }>(sql`SELECT ciphertext FROM project_secrets`);
    const changed = await mutate('alice', 'set', {
      projectId: 'p1',
      scope: 'project',
      name: 'API_KEY',
      allowInSandbox: true,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.allowInSandbox).toBe(true);
    expect(t.db.all(sql`SELECT ciphertext FROM project_secrets`)).toEqual(before);
  });

  test('a shared secret needs manage: a contributor gets 403, an admin saves', async () => {
    expect((await mutate('carol', 'set', secret('project', 'API_KEY'))).status).toBe(403);
    expect((await list('alice')).body).toEqual([]);

    const saved = await mutate('bob', 'set', secret('project', 'API_KEY'));
    expect(saved.status).toBe(200);
    expect((await mutate('carol', 'delete', { projectId: 'p1', id: saved.body.id })).status).toBe(
      403,
    );
    expect((await mutate('bob', 'delete', { projectId: 'p1', id: saved.body.id })).status).toBe(
      200,
    );
  });

  test('a personal secret needs steer and stays with its owner', async () => {
    expect((await mutate('dave', 'set', secret('user', 'MINE'))).status).toBe(403);

    const saved = await mutate('carol', 'set', secret('user', 'MINE'));
    expect(saved.status).toBe(200);
    expect((await list('carol')).body.map((s: any) => s.name)).toEqual(['MINE']);
    expect((await list('bob')).body).toEqual([]);

    // An admin still cannot delete another member's personal secret.
    expect((await mutate('bob', 'delete', { projectId: 'p1', id: saved.body.id })).status).toBe(
      404,
    );
    expect((await mutate('carol', 'delete', { projectId: 'p1', id: saved.body.id })).status).toBe(
      200,
    );
  });

  test('a viewer lists shared secrets; a user without a role gets 404', async () => {
    const saved = await mutate('alice', 'set', secret('project', 'API_KEY'));
    expect((await list('dave')).body.map((s: any) => s.name)).toEqual(['API_KEY']);

    expect((await list('mallory')).status).toBe(404);
    expect((await mutate('mallory', 'set', secret('user', 'MINE'))).status).toBe(404);
    expect((await mutate('mallory', 'delete', { projectId: 'p1', id: saved.body.id })).status).toBe(
      404,
    );
  });

  test('reserved names and bad input are 400', async () => {
    for (const name of [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'PATH',
      'GH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'FUNNY_ASSETS_DIR',
      '1TOKEN',
      'MY-TOKEN',
    ]) {
      expect((await mutate('alice', 'set', secret('project', name))).status).toBe(400);
    }
    expect((await mutate('alice', 'set', secret('project', 'API_KEY', { value: '' }))).status).toBe(
      400,
    );
    expect(
      (await mutate('alice', 'set', secret('project', 'API_KEY', { value: 'x'.repeat(40_000) })))
        .status,
    ).toBe(400);
    expect((await mutate('alice', 'set', secret('project', 'API_KEY', { extra: 1 }))).status).toBe(
      400,
    );
    // A new secret without a value.
    expect(
      (
        await mutate('alice', 'set', {
          projectId: 'p1',
          scope: 'project',
          name: 'API_KEY',
          allowInSandbox: false,
        })
      ).status,
    ).toBe(400);
    expect((await list('alice')).body).toEqual([]);
  });

  test('a multi-line value is stored unchanged', async () => {
    const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkq\n-----END KEY-----\n';
    expect((await mutate('alice', 'set', secret('project', 'PEM', { value: pem }))).status).toBe(
      200,
    );
    const { decrypt } = await import('../../lib/crypto.js');
    const [row] = t.db.all<{ ciphertext: string }>(sql`SELECT ciphertext FROM project_secrets`);
    expect(decrypt(row.ciphertext)).toBe(pem);
  });
});
