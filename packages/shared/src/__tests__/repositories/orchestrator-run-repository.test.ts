import { describe, test, expect, beforeEach } from 'bun:test';

import { createOrchestratorRunRepository } from '../../repositories/orchestrator-run-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createOrchestratorRunRepository>;

beforeEach(() => {
  deps = createTestDb();
  repo = createOrchestratorRunRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db, { id: 't1' });
  seedThread(deps.db, { id: 't2' });
  seedThread(deps.db, { id: 't3', userId: 'user-2' });
});

describe('claim', () => {
  test('inserts a fresh run with attempt=0 and zero token total', async () => {
    const row = await repo.claim({ threadId: 't1', userId: 'user-1', now: 1000 });

    expect(row.threadId).toBe('t1');
    expect(row.userId).toBe('user-1');
    expect(row.attempt).toBe(0);
    expect(row.tokensTotal).toBe(0);
    expect(row.lastEventAtMs).toBe(1000);
    expect(row.claimedAtMs).toBe(1000);
    expect(row.pipelineRunId).toBeNull();

    const stored = await repo.getRun('t1');
    expect(stored?.threadId).toBe('t1');
  });

  test('throws when the thread is already claimed', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await expect(repo.claim({ threadId: 't1', userId: 'user-1' })).rejects.toBeDefined();
  });
});

describe('release', () => {
  test('removes the row so the thread is eligible again', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.release('t1');
    expect(await repo.getRun('t1')).toBeUndefined();
  });
});

describe('listActiveRuns / listActiveRunsByUser', () => {
  test('returns claims, optionally filtered by user', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.claim({ threadId: 't2', userId: 'user-1' });
    await repo.claim({ threadId: 't3', userId: 'user-2' });

    const all = await repo.listActiveRuns();
    expect(all.map((r) => r.threadId).sort()).toEqual(['t1', 't2', 't3']);

    const u1 = await repo.listActiveRunsByUser('user-1');
    expect(u1.map((r) => r.threadId).sort()).toEqual(['t1', 't2']);
  });

  test('claimedThreadIds returns just the IDs', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.claim({ threadId: 't2', userId: 'user-1' });
    const ids = await repo.claimedThreadIds();
    expect(ids.sort()).toEqual(['t1', 't2']);
  });
});

describe('setPipelineRunId / setRetry / touchLastEvent / addTokens', () => {
  test('setPipelineRunId binds the dispatch result', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.setPipelineRunId('t1', 'pr-abc');

    const row = await repo.getRun('t1');
    expect(row?.pipelineRunId).toBe('pr-abc');
  });

  test('setRetry bumps attempt + records error and next due time', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.setRetry({
      threadId: 't1',
      attempt: 2,
      nextRetryAtMs: 5000,
      lastError: 'timeout',
    });

    const row = await repo.getRun('t1');
    expect(row?.attempt).toBe(2);
    expect(row?.nextRetryAtMs).toBe(5000);
    expect(row?.lastError).toBe('timeout');
  });

  test('touchLastEvent updates the heartbeat', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1', now: 1000 });
    await repo.touchLastEvent('t1', 9000);

    const row = await repo.getRun('t1');
    expect(row?.lastEventAtMs).toBe(9000);
  });

  test('addTokens increments cumulatively and ignores non-positive deltas', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.addTokens('t1', 100);
    await repo.addTokens('t1', 50);
    await repo.addTokens('t1', 0);
    await repo.addTokens('t1', -5);

    const row = await repo.getRun('t1');
    expect(row?.tokensTotal).toBe(150);
  });
});

describe('listDueRetries', () => {
  test('returns only rows with next_retry_at_ms <= now', async () => {
    await repo.claim({ threadId: 't1', userId: 'user-1' });
    await repo.claim({ threadId: 't2', userId: 'user-1' });
    await repo.claim({ threadId: 't3', userId: 'user-2' });

    await repo.setRetry({ threadId: 't1', attempt: 1, nextRetryAtMs: 1000, lastError: 'x' });
    await repo.setRetry({ threadId: 't2', attempt: 1, nextRetryAtMs: 2000, lastError: 'y' });
    // t3 never set — next_retry_at_ms IS NULL, must not be returned.

    const due = await repo.listDueRetries(1500);
    expect(due.map((r) => r.threadId)).toEqual(['t1']);

    const dueLater = await repo.listDueRetries(2000);
    expect(dueLater.map((r) => r.threadId).sort()).toEqual(['t1', 't2']);
  });
});

describe('thread_dependencies', () => {
  test('add + remove + listDependenciesFor', async () => {
    await repo.addDependency('t1', 't2');
    await repo.addDependency('t1', 't3');
    await repo.addDependency('t2', 't3');

    const deps = await repo.listDependenciesFor(['t1', 't2']);
    expect(deps.get('t1')?.sort()).toEqual(['t2', 't3']);
    expect(deps.get('t2')).toEqual(['t3']);

    await repo.removeDependency('t1', 't2');
    const after = await repo.listDependenciesFor(['t1']);
    expect(after.get('t1')).toEqual(['t3']);
  });

  test('cascades when one of the threads is deleted', async () => {
    await repo.addDependency('t1', 't2');
    deps.sqlite.exec("DELETE FROM threads WHERE id = 't2'");

    const remaining = await repo.listDependenciesFor(['t1']);
    expect(remaining.size).toBe(0);
  });
});
