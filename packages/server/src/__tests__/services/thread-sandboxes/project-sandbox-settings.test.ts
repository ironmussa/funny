import { beforeEach, describe, expect, test } from 'bun:test';

import { createSandboxProviderRegistry } from '@funny/sandbox';
import { fakeSandboxProviderEntry } from '@funny/sandbox/providers/fake';
import { expectOk } from '@funny/sandbox/testing';
import { Hono } from 'hono';

import type { ServerEnv } from '../../../lib/types.js';
import { createInfraRoutes } from '../../../routes/infra.js';
import { createInfraConnectionService } from '../../../services/thread-sandboxes/infra-connections.js';
import { createProjectSandboxSettingsService } from '../../../services/thread-sandboxes/project-sandbox-settings.js';
import { present } from '../../helpers/builders-services.js';
import { createTestDb, seedProject, seedProjectMember } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db,
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
  test('saves a sandbox connection, size and mode, and reads it back', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    const saved = expectOk(
      await settings.save('alice', 'p1', {
        mode: 'sandbox',
        connectionId,
        sizeId: 'small',
      }),
    );
    expect(saved).toMatchObject({
      projectId: 'p1',
      connectionId,
      sizeId: 'small',
      mode: 'sandbox',
    });
    expect(expectOk(await settings.get('alice', 'p1'))).toEqual(saved);
    expect(expectOk(await settings.get('alice', 'p2'))).toBeNull();
  });

  test('a local runtime stores without requiring a connection', async () => {
    const { settings } = services();
    const saved = expectOk(await settings.save('alice', 'p1', { mode: 'local' }));
    expect(saved.mode).toBe('local');
    expect(expectOk(await settings.get('alice', 'p1'))?.mode).toBe('local');
  });

  test('sandbox mode requires a connection', async () => {
    const { settings } = services();
    const missing = await settings.save('alice', 'p1', { mode: 'sandbox' });
    expect(missing.isErr() && missing.error.kind).toBe('not-found');
  });

  test('an omitted size stores the provider default; saving again replaces the row', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { mode: 'sandbox', connectionId }));
    expect(expectOk(await settings.get('alice', 'p1'))?.sizeId).toBe('default');
    expectOk(
      await settings.save('alice', 'p1', { mode: 'sandbox', connectionId, sizeId: 'small' }),
    );
    expect(expectOk(await settings.get('alice', 'p1'))?.sizeId).toBe('small');
    const rows = present(
      testDb.sqlite
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_sandbox_settings')
        .get(),
      'a count',
    );
    expect(rows.n).toBe(1);
  });

  test("refuses another user's connection, an unknown size and a project not owned", async () => {
    const { connections, settings } = services();
    const bobConnection = await connect(connections, 'bob');
    const aliceConnection = await connect(connections);

    const foreign = await settings.save('alice', 'p1', {
      mode: 'sandbox',
      connectionId: bobConnection,
    });
    expect(foreign.isErr() && foreign.error.kind).toBe('not-found');

    const badSize = await settings.save('alice', 'p1', {
      mode: 'sandbox',
      connectionId: aliceConnection,
      sizeId: 'huge',
    });
    expect(badSize.isErr() && badSize.error.kind).toBe('invalid-size');

    const notOwned = await settings.save('alice', 'bob-project', {
      mode: 'sandbox',
      connectionId: aliceConnection,
    });
    expect(notOwned.isErr() && notOwned.error.kind).toBe('not-found');
    const read = await settings.get('alice', 'bob-project');
    expect(read.isErr() && read.error.kind).toBe('not-found');
    expect(expectOk(await settings.get('alice', 'p1'))).toBeNull();
  });

  test('a project member (not the owner) can set their own runtime', async () => {
    const { settings } = services();
    // 'bob-project' is owned by bob; make alice a member.
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    const saved = expectOk(await settings.save('alice', 'bob-project', { mode: 'worktree' }));
    expect(saved.mode).toBe('worktree');
    expect(expectOk(await settings.get('alice', 'bob-project'))?.mode).toBe('worktree');
    // A non-member still cannot.
    const outsider = await settings.save('carol', 'bob-project', { mode: 'worktree' });
    expect(outsider.isErr() && outsider.error.kind).toBe('not-found');
  });

  test('a viewer member can read but not set their runtime', async () => {
    const { settings } = services();
    // `setMemberLocalPath` writes viewer rows like this one for org viewers.
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'viewer' });
    expect(expectOk(await settings.get('alice', 'bob-project'))).toBeNull();
    const saved = await settings.save('alice', 'bob-project', { mode: 'worktree' });
    expect(saved.isErr() && saved.error.kind).toBe('forbidden');
    const cleared = await settings.clear('alice', 'bob-project');
    expect(cleared.isErr() && cleared.error.kind).toBe('forbidden');
  });

  test('each user keeps their own configuration for the same project', async () => {
    const { connections, settings } = services();
    seedProject(testDb.db, { id: 'shared', userId: 'alice', path: '/tmp/shared' });
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'shared', { mode: 'sandbox', connectionId }));
    expect(expectOk(await settings.forThread('bob', 'shared'))).toBeNull();
    expect(expectOk(await settings.forThread('alice', 'shared'))?.connectionId).toBe(connectionId);
  });

  test('clear drops the sandbox; a sandbox runtime falls back to local', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { mode: 'sandbox', connectionId }));
    expectOk(await settings.clear('alice', 'p1'));
    expect(expectOk(await settings.get('alice', 'p1'))).toMatchObject({
      mode: 'local',
      connectionId: '',
    });
    // No connection left: thread creation sees no sandbox.
    expect(expectOk(await settings.forThread('alice', 'p1'))?.connectionId).toBe('');
  });

  test('clearing the sandbox keeps a worktree runtime', async () => {
    const { connections, settings } = services();
    const connectionId = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { mode: 'sandbox', connectionId }));
    expectOk(await settings.save('alice', 'p1', { mode: 'worktree' }));
    expectOk(await settings.clear('alice', 'p1'));
    expect(expectOk(await settings.get('alice', 'p1'))).toMatchObject({
      mode: 'worktree',
      connectionId: '',
    });
  });

  test('removing a connection detaches it from the projects that use it, keeping their runtime', async () => {
    const { connections, settings } = services();
    seedProject(testDb.db, { id: 'p3', userId: 'alice', path: '/tmp/p3' });
    const used = await connect(connections);
    const other = await connect(connections);
    expectOk(await settings.save('alice', 'p1', { mode: 'sandbox', connectionId: used }));
    expectOk(await settings.save('alice', 'p3', { mode: 'sandbox', connectionId: used }));
    expectOk(await settings.save('alice', 'p3', { mode: 'worktree' }));
    expectOk(await settings.save('alice', 'p2', { mode: 'sandbox', connectionId: other }));
    expectOk(await connections.remove('alice', used));
    expect(expectOk(await settings.get('alice', 'p1'))).toMatchObject({
      mode: 'local',
      connectionId: '',
    });
    expect(expectOk(await settings.get('alice', 'p3'))).toMatchObject({
      mode: 'worktree',
      connectionId: '',
    });
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

  test('GET answers null until configured, PUT stores, DELETE drops the sandbox', async () => {
    const connectionId = await connect(services().connections);
    const empty = await app().request('/api/infra/projects/p1/sandbox');
    expect(await empty.json()).toEqual({ settings: null });

    const saved = await put({ mode: 'sandbox', connectionId, sizeId: 'small' });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ connectionId, sizeId: 'small' });

    const read = await (await app().request('/api/infra/projects/p1/sandbox')).json();
    expect(read.settings.connectionId).toBe(connectionId);

    const cleared = await app().request('/api/infra/projects/p1/sandbox', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    const after = await (await app().request('/api/infra/projects/p1/sandbox')).json();
    expect(after.settings).toMatchObject({ mode: 'local', connectionId: '' });
  });

  test('refuses malformed bodies, unknown sizes, foreign projects and connections', async () => {
    const connectionId = await connect(services().connections);
    expect((await put({ connectionId })).status).toBe(400);
    expect((await put({ mode: 'sandbox', connectionId, sizeId: 'huge' })).status).toBe(400);
    expect((await put({ mode: 'sandbox', connectionId }, 'bob-project')).status).toBe(404);
    expect((await put({ mode: 'sandbox', connectionId }, 'p1', 'bob')).status).toBe(404);
    const bobRead = await app('bob').request('/api/infra/projects/p1/sandbox');
    expect(bobRead.status).toBe(404);
  });
});
