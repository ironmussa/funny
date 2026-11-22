/**
 * Issue #202: a member removed from a project loses the thread shares they
 * held on that project's threads (a share needs project membership), and their
 * live sockets leave those threads' stream and presence rooms at once.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { THREAD_SHARE_REVOKED_EVENT } from '@funny/shared/socket-events';

import { repos } from '../../db/repos.js';
import { canUserViewThread } from '../../services/thread-access-check.js';
import { FakeBrowserEventSink } from '../helpers/runner-port-fakes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember, seedThread } from '../helpers/test-db.js';

const evictions = (sink: FakeBrowserEventSink) =>
  sink.deliveries
    .filter((d) => d.target === 'evict')
    .map((d) => d.id!.split('\0'))
    .sort();

const revokedEvents = (sink: FakeBrowserEventSink) =>
  sink.deliveries
    .filter((d) => (d.event as { type?: string } | undefined)?.type === THREAD_SHARE_REVOKED_EVENT)
    .map((d) => [d.id, (d.event as { threadId: string }).threadId])
    .sort();

describe('removing a project member ends their live thread access', () => {
  let t: TestApp;
  let sink: FakeBrowserEventSink;

  const removeMember = (actorId: string, projectId: string, userId: string) =>
    t.app.request('/api/trpc/projects.removeMember', {
      method: 'POST',
      headers: { 'X-Test-User-Id': actorId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, userId }),
    });

  beforeAll(async () => {
    sink = new FakeBrowserEventSink();
    t = await createTestApp({ browserEvents: sink });
  });

  beforeEach(async () => {
    t.cleanup();
    sink.deliveries.length = 0;
    seedProject(t.db, { id: 'p1', userId: 'owner', path: '/tmp/p1' });
    seedProject(t.db, { id: 'p2', userId: 'owner', path: '/tmp/p2' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    seedProjectMember(t.db, { projectId: 'p2', userId: 'bob', role: 'member' });
    seedThread(t.db, { id: 't-shared', projectId: 'p1', userId: 'owner' });
    seedThread(t.db, { id: 't-bob', projectId: 'p1', userId: 'bob' });
    seedThread(t.db, { id: 't-other', projectId: 'p2', userId: 'owner' });
    const shares = repos.threadShares();
    for (const threadId of ['t-shared', 't-other']) {
      await shares.createShare({
        threadId,
        sharedWithUserId: 'bob',
        sharedByUserId: 'owner',
        level: 'view',
      });
    }
  });

  test('the removed member is evicted from the threads shared with them in that project', async () => {
    expect(await canUserViewThread('t-shared', 'bob')).toBe(true);

    const res = await removeMember('owner', 'p1', 'bob');
    expect(res.status).toBe(200);

    expect(await canUserViewThread('t-shared', 'bob')).toBe(false);
    expect(evictions(sink)).toEqual([['bob', 't-shared']]);
    expect(revokedEvents(sink)).toEqual([['bob', 't-shared']]);
    // Their own thread and the share in another project are untouched.
    expect(await canUserViewThread('t-bob', 'bob')).toBe(true);
    expect(await canUserViewThread('t-other', 'bob')).toBe(true);
  });

  test('leaving a project evicts the same way', async () => {
    expect((await removeMember('bob', 'p1', 'bob')).status).toBe(200);
    expect(evictions(sink)).toEqual([['bob', 't-shared']]);
  });

  test('a refused removal revokes and evicts nothing', async () => {
    seedProjectMember(t.db, { projectId: 'p1', userId: 'carol', role: 'member' });
    expect((await removeMember('carol', 'p1', 'bob')).status).toBe(403);
    expect(evictions(sink)).toEqual([]);
    expect(await canUserViewThread('t-shared', 'bob')).toBe(true);
  });
});
