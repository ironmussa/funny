/**
 * Merge approval requests (openspec factory-agent-tools): the transition
 * function that reads the run, and the compare-and-set writers. Real test DB.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  createFactoryApprovalRequestsRepository,
  heldCommit,
  nextRequestState,
  type RequestRunFacts,
} from '../../../services/factory/factory-approval-requests.js';
import { createTestDb } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

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
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const held = (sha: string, over: Partial<RequestRunFacts> = {}): RequestRunFacts => ({
  state: 'waiting_human',
  failureReason: 'high risk',
  risk: { headSha: sha, level: 'high', reasons: ['big'], changedLines: 900, paths: [] },
  mergeApproval: null,
  ...over,
});
const pending = { state: 'pending' as const, sha: A };

describe('nextRequestState', () => {
  test('stays pending while the run is held on the same commit', () => {
    expect(nextRequestState(pending, held(A))).toBeNull();
  });

  test('expires when the run is held on another commit', () => {
    expect(nextRequestState(pending, held(B))).toBe('expired');
  });

  test('expires when the run left the hold without an approval', () => {
    expect(nextRequestState(pending, held(A, { state: 'working' }))).toBe('expired');
    expect(nextRequestState(pending, held(A, { failureReason: 'review failed' }))).toBe('expired');
    expect(nextRequestState(pending, held(A, { state: 'stopped' }))).toBe('expired');
    expect(nextRequestState(pending, null)).toBe('expired');
  });

  test('is approved once a member approved its commit, from the card or from the board', () => {
    const approval = { sha: A, userId: 'alice', at: 'now' };
    expect(nextRequestState(pending, held(A, { state: 'queued', mergeApproval: approval }))).toBe(
      'approved',
    );
    // The approval moved on to a merge of the base: it was still given for A.
    const moved = { sha: B, carriedFrom: A, userId: 'alice', at: 'now' };
    expect(nextRequestState(pending, held(B, { state: 'merging', mergeApproval: moved }))).toBe(
      'approved',
    );
  });

  test('an approval of another commit approves nothing here', () => {
    const other = { sha: B, userId: 'alice', at: 'earlier' };
    expect(nextRequestState(pending, held(A, { mergeApproval: other }))).toBeNull();
  });

  test('a closed request never moves', () => {
    for (const state of ['approved', 'declined', 'expired'] as const) {
      expect(nextRequestState({ state, sha: A }, held(B))).toBeNull();
    }
  });

  test('heldCommit is the high-risk hold only', () => {
    expect(heldCommit(held(A))).toBe(A);
    expect(heldCommit(held(A, { state: 'failed' }))).toBeNull();
    expect(heldCommit(held(A, { risk: null }))).toBeNull();
  });
});

describe('approval requests repository', () => {
  const input = { runId: 'r1', factoryId: 'f1', projectId: 'p1', threadId: 't1', sha: A };
  let n = 0;
  const repo = () =>
    createFactoryApprovalRequestsRepository({
      newId: () => `q${++n}`,
      now: () => new Date('2026-11-24T12:00:00.000Z'),
    });

  test('asking twice for the same commit returns the one request', async () => {
    const requests = repo();
    const first = (await requests.ask(input))._unsafeUnwrap();
    const second = (await requests.ask({ ...input, threadId: 't2' }))._unsafeUnwrap();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.threadId).toBe('t1');
    expect((await requests.listForFactory('f1'))._unsafeUnwrap()).toHaveLength(1);
  });

  test('asking for a newer commit expires the request of the older one', async () => {
    const requests = repo();
    const old = (await requests.ask(input))._unsafeUnwrap().request;
    const next = (await requests.ask({ ...input, sha: B }))._unsafeUnwrap();
    expect(next.created).toBe(true);
    expect(next.request).toMatchObject({ sha: B, state: 'pending' });
    expect((await requests.get(old.id))._unsafeUnwrap()).toMatchObject({ state: 'expired' });
  });

  test('a request is closed once: the second writer changes nothing', async () => {
    const requests = repo();
    const { request } = (await requests.ask(input))._unsafeUnwrap();
    expect((await requests.resolve(request.id, 'declined', 'alice'))._unsafeUnwrap()).toBe(true);
    expect((await requests.resolve(request.id, 'approved', 'alice'))._unsafeUnwrap()).toBe(false);
    expect((await requests.get(request.id))._unsafeUnwrap()).toMatchObject({
      state: 'declined',
      resolvedAt: '2026-11-24T12:00:00.000Z',
    });
    expect((await requests.pendingForRun('r1'))._unsafeUnwrap()).toBeNull();
  });

  test('sync closes the pending request as the run says, and only then', async () => {
    const requests = repo();
    const { request } = (await requests.ask(input))._unsafeUnwrap();
    expect((await requests.sync('r1', held(A)))._unsafeUnwrap()).toBeNull();
    const approval = { sha: A, userId: 'alice', at: 'now' };
    const closed = (
      await requests.sync('r1', held(A, { state: 'queued', mergeApproval: approval }), 'alice')
    )._unsafeUnwrap();
    expect(closed).toMatchObject({ id: request.id, state: 'approved' });
    // Nothing is pending any more.
    expect((await requests.sync('r1', held(B)))._unsafeUnwrap()).toBeNull();

    const again = (await requests.ask({ ...input, runId: 'r2' }))._unsafeUnwrap().request;
    expect((await requests.sync('r2', held(B)))._unsafeUnwrap()).toMatchObject({
      id: again.id,
      state: 'expired',
    });
  });
});
