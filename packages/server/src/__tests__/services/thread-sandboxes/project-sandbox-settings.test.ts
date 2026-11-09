import { beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../../lib/types.js';
import { createInfraRoutes } from '../../../routes/infra.js';
import { createInfraConnectionService } from '../../../services/thread-sandboxes/infra-connections.js';
import { createProjectSandboxSettingsService } from '../../../services/thread-sandboxes/project-sandbox-settings.js';
import { fakeSandboxProviderEntry } from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { createSandboxProviderRegistry } from '../../../services/thread-sandboxes/registry.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';
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
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProject(testDb.db, { id: 'p2', userId: 'alice', path: '/tmp/other' });
  seedProject(testDb.db, { id: 'bob-project', userId: 'bob', path: '/tmp/bob' });
});

const services = () => {
  const connections = createInfraConnectionService(registry);
  return { connections, settings: createProjectSandboxSettingsService(connections) };
};

const connect = async (
  connections: ReturnType<typeof createInfraConnectionService>,
  userId = 'alice',
) =>
  expectOk(
    await connections.add(userId, { provider: 'fake', label: 'Fake', credential: 'fake-valid' }),
  ).id;

describe('project sandbox settings service', () => {
  test('saves a connection, size and default, and reads it back', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    const saved = expectOk(
      await settings.save('alice', 'p1', {
        connectionId,
        sizeId: 'small',
        enabledByDefault: false,
      }),
    );
    expect(saved).toMatchObject({
      projectId: 'p1',
      connectionId,
      sizeId: 'small',
      enabledByDefault: false,
    });
    expect(expectOk(await settings.get('alice', 'p1'))).toEqual(saved);
    expect(expectOk(await settings.get('alice', 'p2'))).toBeNull();
  });

  test('an omitted size stores the provider default; saving again replaces the row', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { connectionId, enabledByDefault: true }));
    expect(expectOk(await settings.get('alice', 'p1'))?.sizeId).toBe('default');
    expectOk(
      await settings.save('alice', 'p1', { connectionId, sizeId: 'small', enabledByDefault: true }),
    );
    expect(expectOk(await settings.get('alice', 'p1'))?.sizeId).toBe('small');
    const rows = testDb.sqlite
      .query('SELECT COUNT(*) AS n FROM project_sandbox_settings')
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  test("refuses another user's connection, an unknown size and a project not owned", async () => {
    const { connections, settings } = services();
    const bobConnection = await connect(connections, 'bob');
    const aliceConnection = await connect(connections);

    const foreign = await settings.save('alice', 'p1', {
      connectionId: bobConnection,
      enabledByDefault: true,
    });
    expect(foreign.isErr() && foreign.error.kind).toBe('not-found');

    const badSize = await settings.save('alice', 'p1', {
      connectionId: aliceConnection,
      sizeId: 'huge',
      enabledByDefault: true,
    });
    expect(badSize.isErr() && badSize.error.kind).toBe('invalid-size');

    const notOwned = await settings.save('alice', 'bob-project', {
      connectionId: aliceConnection,
      enabledByDefault: true,
    });
    expect(notOwned.isErr() && notOwned.error.kind).toBe('not-found');
    const read = await settings.get('alice', 'bob-project');
    expect(read.isErr() && read.error.kind).toBe('not-found');
    expect(expectOk(await settings.get('alice', 'p1'))).toBeNull();
  });

  test('each user keeps their own configuration for the same project', async () => {
    const { connections, settings } = services();
    seedProject(testDb.db, { id: 'shared', userId: 'alice', path: '/tmp/shared' });
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'shared', { connectionId, enabledByDefault: true }));
    expect(expectOk(await settings.forThread('bob', 'shared'))).toBeNull();
    expect(expectOk(await settings.forThread('alice', 'shared'))?.connectionId).toBe(connectionId);
  });

  test('clear removes it', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { connectionId, enabledByDefault: true }));
    expectOk(await settings.clear('alice', 'p1'));
    expect(expectOk(await settings.get('alice', 'p1'))).toBeNull();
  });

  test('removing a connection clears the projects that use it', async () => {
    const { connections, settings } = services();
    const used = await connect(connections);
    const other = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { connectionId: used, enabledByDefault: true }));
    expectOk(await settings.save('alice', 'p2', { connectionId: other, enabledByDefault: true }));
    expectOk(await connections.remove('alice', used));
    expect(expectOk(await settings.get('alice', 'p1'))).toBeNull();
    expect(expectOk(await settings.get('alice', 'p2'))?.connectionId).toBe(other);
  });
});

describe('project sandbox routes', () => {
  const app = (userId = 'alice') => {
    const root = new Hono<ServerEnv>();
    root.use('*', async (c, next) => {
      c.set('userId', userId);
      await next();
    });
    root.route('/api/infra', createInfraRoutes(registry));
    return root;
  };
  const put = (body: unknown, projectId = 'p1', userId = 'alice') =>
    app(userId).request(`/api/infra/projects/${projectId}/sandbox`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('GET answers null until configured, PUT stores, DELETE clears', async () => {
    const connectionId = await connect(services().connections);
    const empty = await app().request('/api/infra/projects/p1/sandbox');
    expect(await empty.json()).toEqual({ settings: null });

    const saved = await put({ connectionId, sizeId: 'small', enabledByDefault: true });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ connectionId, sizeId: 'small' });

    const read = await (await app().request('/api/infra/projects/p1/sandbox')).json();
    expect(read.settings.connectionId).toBe(connectionId);

    const cleared = await app().request('/api/infra/projects/p1/sandbox', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(await (await app().request('/api/infra/projects/p1/sandbox')).json()).toEqual({
      settings: null,
    });
  });

  test('refuses malformed bodies, unknown sizes, foreign projects and connections', async () => {
    const connectionId = await connect(services().connections);
    expect((await put({ connectionId })).status).toBe(400);
    expect((await put({ connectionId, sizeId: 'huge', enabledByDefault: true })).status).toBe(400);
    expect((await put({ connectionId, enabledByDefault: true }, 'bob-project')).status).toBe(404);
    expect((await put({ connectionId, enabledByDefault: true }, 'p1', 'bob')).status).toBe(404);
    const bobRead = await app('bob').request('/api/infra/projects/p1/sandbox');
    expect(bobRead.status).toBe(404);
  });
});
