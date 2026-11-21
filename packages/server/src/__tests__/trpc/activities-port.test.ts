/**
 * The `activities` tRPC port (track-background-activities, design D6): a user
 * lists and removes only their own activities, a running one stays while its
 * runner is connected, and removals are broadcast to the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { repos } from '../../db/repos.js';
import { setIO } from '../../services/browser-events.js';
import { createActivitiesPort } from '../../trpc/ports/activities.js';
import { createMockIo } from '../helpers/socketio-test-mocks.js';

const online = new Set<string>();
const port = createActivitiesPort({ isAvailable: async (id) => online.has(id) });

async function seed(id: string, userId: string, status: 'running' | 'succeeded' | 'failed') {
  await repos.activities().insert({
    id,
    userId,
    runnerId: 'r1',
    kind: 'project.clone',
    projectId: null,
    threadId: null,
    title: id,
    input: {},
    startedAt: new Date().toISOString(),
  });
  if (status !== 'running') await repos.activities().update(id, { status });
}

describe('activities port', () => {
  let db: (typeof import('../../db/index.js'))['db'];
  let capture: ReturnType<typeof createMockIo>['capture'];

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(() => {
    db.run('DELETE FROM activities');
    online.clear();
    const mockIo = createMockIo();
    capture = mockIo.capture;
    setIO(mockIo.io);
  });

  afterAll(() => setIO(null!));

  test('list returns only the caller rows', async () => {
    await seed('mine', 'alice', 'failed');
    await seed('theirs', 'bob', 'failed');
    const res = await port.list('alice');
    expect(res._unsafeUnwrap().map((a) => a.id)).toEqual(['mine']);
  });

  test("dismissing another user's row answers 404", async () => {
    await seed('theirs', 'bob', 'failed');
    const res = await port.dismiss('alice', 'theirs');
    expect(res._unsafeUnwrapErr().status).toBe(404);
    expect(await repos.activities().getById('theirs')).toBeDefined();
  });

  test('a running row with a connected runner answers 409', async () => {
    online.add('r1');
    await seed('run', 'alice', 'running');
    expect((await port.dismiss('alice', 'run'))._unsafeUnwrapErr().status).toBe(409);
    expect(await repos.activities().getById('run')).toBeDefined();
  });

  test('a running row whose runner is offline is deleted', async () => {
    await seed('run', 'alice', 'running');
    expect((await port.dismiss('alice', 'run'))._unsafeUnwrap()).toEqual({ ids: ['run'] });
    expect(await repos.activities().getById('run')).toBeUndefined();
  });

  test('dismissing a finished row broadcasts activity:removed to the owner', async () => {
    await seed('done', 'alice', 'failed');
    await port.dismiss('alice', 'done');
    const event = capture.userRoomEmits.find((e) => e.event === 'activity:removed');
    expect(event?.room).toBe('user:alice');
    expect((event!.payload as any).data).toEqual({ ids: ['done'] });
  });

  test('clear finished keeps running rows', async () => {
    await seed('run', 'alice', 'running');
    await seed('a', 'alice', 'succeeded');
    await seed('b', 'alice', 'failed');
    await seed('c', 'bob', 'failed');
    const res = await port.clearFinished('alice');
    expect(res._unsafeUnwrap().ids.sort()).toEqual(['a', 'b']);
    expect((await port.list('alice'))._unsafeUnwrap().map((a) => a.id)).toEqual(['run']);
    expect(await repos.activities().getById('c')).toBeDefined();
  });
});
