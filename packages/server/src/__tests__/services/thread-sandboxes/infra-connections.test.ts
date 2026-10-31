import { beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../../lib/types.js';
import { createInfraRoutes } from '../../../routes/infra.js';
import { createInfraConnectionService } from '../../../services/thread-sandboxes/infra-connections.js';
import { fakeSandboxProviderEntry } from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { createSandboxProviderRegistry } from '../../../services/thread-sandboxes/registry.js';
import { sqlThreadSandboxStore } from '../../../services/thread-sandboxes/thread-sandbox-store.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';
import { expectOk } from './provider-contract.js';

let testDb: ReturnType<typeof createTestDb>;
const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
});

const add = (service: ReturnType<typeof createInfraConnectionService>, userId = 'alice') =>
  service.add(userId, { provider: 'fake', label: 'My fake', credential: 'fake-valid' });

describe('infra connection service', () => {
  test('validates, stores the credential encrypted and never returns it', async () => {
    const service = createInfraConnectionService(registry);
    const view = expectOk(await add(service));
    expect(view).toMatchObject({
      provider: 'fake',
      label: 'My fake',
      accountLabel: 'fake-account',
    });
    expect(JSON.stringify(view)).not.toContain('fake-valid');

    const stored = testDb.sqlite.query('SELECT credential_enc FROM infra_connections').get() as {
      credential_enc: string;
    };
    expect(stored.credential_enc).not.toContain('fake-valid');

    const { provider } = expectOk(await service.providerFor('alice', view.id));
    expect((await provider.validate()).isOk()).toBe(true);
  });

  test('a credential the provider rejects is not stored', async () => {
    const service = createInfraConnectionService(registry);
    const result = await service.add('alice', {
      provider: 'fake',
      label: 'bad',
      credential: 'wrong',
    });
    expect(result.isErr() && result.error.kind).toBe('rejected');
    expect(expectOk(await service.list('alice'))).toHaveLength(0);
  });

  test('unknown providers and invalid config are refused', async () => {
    const service = createInfraConnectionService(registry);
    const unknown = await service.add('alice', { provider: 'nope', label: 'x', credential: 'k' });
    expect(unknown.isErr() && unknown.error.kind).toBe('unknown-provider');
    const config = await service.add('alice', {
      provider: 'fake',
      label: 'x',
      credential: 'fake-valid',
      config: { unexpected: true },
    });
    expect(config.isErr() && config.error.kind).toBe('invalid-config');
  });

  test('connections are invisible to other users', async () => {
    const service = createInfraConnectionService(registry);
    const view = expectOk(await add(service));
    expect(expectOk(await service.list('mallory'))).toHaveLength(0);
    for (const result of [
      await service.test('mallory', view.id),
      await service.remove('mallory', view.id),
      await service.providerFor('mallory', view.id),
    ]) {
      expect(result.isErr() && result.error.kind).toBe('not-found');
    }
    expect(expectOk(await service.list('alice'))).toHaveLength(1);
  });

  test('test re-validates and remove deletes', async () => {
    const service = createInfraConnectionService(registry);
    const view = expectOk(await add(service));
    expect(expectOk(await service.test('alice', view.id)).lastValidatedAt).toBeTruthy();
    expectOk(await service.remove('alice', view.id));
    expect(expectOk(await service.list('alice'))).toHaveLength(0);
  });
});

describe('infra routes', () => {
  const app = (userId = 'alice') => {
    const root = new Hono<ServerEnv>();
    root.use('*', async (c, next) => {
      c.set('userId', userId);
      await next();
    });
    root.route('/api/infra', createInfraRoutes(registry));
    return root;
  };

  test('lists providers with capabilities and manages connections without leaking secrets', async () => {
    const providers = await (await app().request('/api/infra/providers')).json();
    expect(providers.providers[0]).toMatchObject({ id: 'fake' });

    const created = await app().request('/api/infra/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'fake', label: 'Mine', credential: 'fake-valid' }),
    });
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(body).not.toContain('fake-valid');

    const listed = await (await app().request('/api/infra/connections')).json();
    expect(listed.connections).toHaveLength(1);
    const others = await (await app('mallory').request('/api/infra/connections')).json();
    expect(others.connections).toHaveLength(0);
  });

  test('rejected credentials answer 422 and malformed bodies 400', async () => {
    const rejected = await app().request('/api/infra/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'fake', label: 'Mine', credential: 'wrong' }),
    });
    expect(rejected.status).toBe(422);
    const malformed = await app().request('/api/infra/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'fake' }),
    });
    expect(malformed.status).toBe(400);
  });

  describe('thread sandbox routes', () => {
    const post = (userId: string, threadId: string) =>
      app(userId).request(`/api/infra/threads/${threadId}/sandbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: 'conn-1' }),
      });
    const saved = { ...process.env };
    beforeEach(() => {
      seedProject(testDb.db, { id: 'px', userId: 'alice', path: '/tmp/px' });
      seedThread(testDb.db, { id: 't-1', projectId: 'px', userId: 'alice' });
      process.env.FUNNY_BUILD_COMMIT = 'd'.repeat(40);
      process.env.FUNNY_PUBLIC_URL = 'https://funny.example';
    });
    const restore = () => {
      for (const key of ['FUNNY_BUILD_COMMIT', 'FUNNY_PUBLIC_URL']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    };

    test('refuses without a known build commit', async () => {
      delete process.env.FUNNY_BUILD_COMMIT;
      const res = await post('alice', 't-1');
      restore();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('missing-build-commit');
    });

    test('refuses another user’s thread and an already active sandbox', async () => {
      const foreign = await post('mallory', 't-1');
      expect(foreign.status).toBe(404);

      expectOk(
        await sqlThreadSandboxStore.put({
          threadId: 't-1',
          userId: 'alice',
          connectionId: 'conn-1',
          provider: 'fake',
          sandboxId: 'fake-1',
          runnerId: 'r-box',
          sizeId: 'default',
          state: 'running',
          error: null,
          generation: 0,
          createdAt: '2026-10-31T00:00:00Z',
          updatedAt: '2026-10-31T00:00:00Z',
        }),
      );
      const active = await post('alice', 't-1');
      restore();
      expect(active.status).toBe(409);
      expect((await active.json()).code).toBe('already-provisioned');
    });

    test('the sandbox state is visible only to its owner', async () => {
      expectOk(
        await sqlThreadSandboxStore.put({
          threadId: 't-1',
          userId: 'alice',
          connectionId: 'conn-1',
          provider: 'fake',
          sandboxId: null,
          runnerId: null,
          sizeId: 'default',
          state: 'provisioning',
          error: null,
          generation: 0,
          createdAt: '2026-10-31T00:00:00Z',
          updatedAt: '2026-10-31T00:00:00Z',
        }),
      );
      restore();
      const own = await app('alice').request('/api/infra/threads/t-1/sandbox');
      expect(own.status).toBe(200);
      expect((await own.json()).state).toBe('provisioning');
      const other = await app('mallory').request('/api/infra/threads/t-1/sandbox');
      expect(other.status).toBe(404);
    });

    test('refuses when the repository URL cannot be determined', async () => {
      const res = await post('alice', 't-1');
      restore();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('repo-url-unknown');
    });
  });
});
