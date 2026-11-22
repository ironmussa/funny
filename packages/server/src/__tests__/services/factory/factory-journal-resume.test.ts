/**
 * Factory resume through the engine's journal (change workflow-dag-engine,
 * task 3.5): an agent step checkpoints its launch, its thread and its
 * follow-up, and a resumed step adopts that work instead of starting it again.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import type { JournalEntry, NodeRunInfo } from '@funny/pipelines';
import { ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';
import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createWorkflowJournalRepository } from '../../../services/workflow-engine/journal-repository.js';
import { createTestDb, seedProject } from '../../helpers/test-db.js';

const scope = {
  runId: 'r1',
  userId: 'alice',
  projectId: 'p1',
  repo: 'o/r',
  mode: 'local' as const,
  issueNumber: 7,
  issueTitle: 'Fix it',
  branch: 'factory/issue-7-r1',
};

/** An execution as the engine hands it to an action, resumed with `data` when given. */
function execution(data?: unknown) {
  const checkpoints: unknown[] = [];
  const info: NodeRunInfo = {
    iteration: 1,
    visit: '1',
    checkpoint: async (state) => {
      checkpoints.push(state);
    },
  };
  if (data !== undefined) {
    const recorded: JournalEntry<unknown> = {
      runId: 'r1',
      nodeId: 'implement',
      visit: '1',
      attempt: 1,
      status: 'running',
      data,
      startedAt: 1,
    };
    info.resume = { recorded };
  }
  return { info, checkpoints };
}

function journaledProvider(over: Partial<Parameters<typeof createFactoryActionProvider>[0]> = {}) {
  const launched: string[] = [];
  const waited: string[] = [];
  const followUps: string[] = [];
  const provider = createFactoryActionProvider({
    scope,
    threadIds: [],
    prUrl: null,
    launchStartedAt: null,
    legacyReplay: false,
    findLaunched: async () => null,
    launch: async () => {
      launched.push('t-new');
      return ok({ thread: { id: 't-new' }, threadId: 't-new', runnerId: 'r' });
    },
    waitThread: async (threadId) => {
      waited.push(threadId);
      return { status: 'completed' as const, output: 'done' };
    },
    continuation: {
      followUp: async (threadId, content) => {
        followUps.push(`${threadId}:${content}`);
        return ok(undefined);
      },
      completedAt: async () => '2026-11-20T10:00:00.000Z',
      followedUpSince: async () => false,
    },
    github: {
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {
        prState: () => okAsync('open' as const),
        pullHead: () => okAsync({ sha: 'sha-head', baseRef: 'main', autoMerge: false }),
        publishProofCheck: () => okAsync(undefined),
        ciState: () => okAsync({ kind: 'green' as const }),
        merge: () =>
          okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
      },
    },
    record: async () => undefined,
    signal: new AbortController().signal,
    ...over,
  });
  return { provider, launched, waited, followUps };
}

describe('factory resume through the journal', () => {
  test('a new step checkpoints its launch, then its thread', async () => {
    const { provider, launched } = journaledProvider();
    const exec = execution();
    const result = await provider.spawnAgent({
      prompt: 'implement',
      cwd: '',
      execution: exec.info,
    });
    expect(result).toMatchObject({ ok: true, metadata: { threadId: 't-new' } });
    expect(launched).toEqual(['t-new']);
    expect(exec.checkpoints).toEqual([
      { phase: 'launching', since: expect.any(String) },
      { phase: 'thread', threadId: 't-new' },
    ]);
  });

  test('a resumed step adopts the thread it checkpointed and waits on it', async () => {
    const { provider, launched, waited } = journaledProvider();
    const exec = execution({ phase: 'thread', threadId: 't-1' });
    await provider.spawnAgent({ prompt: 'implement', cwd: '', execution: exec.info });
    expect(launched).toEqual([]);
    expect(waited).toEqual(['t-1']);
  });

  test('a resumed launch adopts the thread it started before the restart', async () => {
    const since: string[] = [];
    const { provider, launched, waited } = journaledProvider({
      findLaunched: async (_prefix, at) => {
        since.push(at);
        return 't-orphan';
      },
    });
    const exec = execution({ phase: 'launching', since: '2026-11-20T10:00:00.000Z' });
    await provider.spawnAgent({ prompt: 'implement', cwd: '', execution: exec.info });
    expect(since).toEqual(['2026-11-20T10:00:00.000Z']);
    expect(launched).toEqual([]);
    expect(waited).toEqual(['t-orphan']);
    expect(exec.checkpoints).toEqual([{ phase: 'thread', threadId: 't-orphan' }]);
  });

  test('a resumed launch that never started a thread starts one', async () => {
    const { provider, launched } = journaledProvider();
    const exec = execution({ phase: 'launching', since: '2026-11-20T10:00:00.000Z' });
    await provider.spawnAgent({ prompt: 'implement', cwd: '', execution: exec.info });
    expect(launched).toEqual(['t-new']);
  });

  test('a resumed follow-up that reached the thread is not sent again', async () => {
    const { provider, followUps, waited } = journaledProvider({
      threadIds: ['t-1'],
      continuation: {
        followUp: async () => ok(undefined),
        completedAt: async () => null,
        followedUpSince: async () => true,
      },
    });
    const exec = execution({
      phase: 'following-up',
      threadId: 't-1',
      since: '2026-11-20T10:05:00.000Z',
      before: '2026-11-20T10:00:00.000Z',
    });
    await provider.spawnAgent({ prompt: 'fix', cwd: '', execution: exec.info });
    expect(followUps).toEqual([]);
    expect(waited).toEqual(['t-1']);
    expect(exec.checkpoints).toEqual([
      {
        phase: 'thread',
        threadId: 't-1',
        after: { completedAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T10:05:00.000Z' },
      },
    ]);
  });

  test('a resumed follow-up that never reached the thread is sent', async () => {
    const { provider, followUps } = journaledProvider({ threadIds: ['t-1'] });
    const exec = execution({
      phase: 'following-up',
      threadId: 't-1',
      since: '2026-11-20T10:05:00.000Z',
      before: null,
    });
    await provider.spawnAgent({ prompt: 'fix', cwd: '', execution: exec.info });
    expect(followUps).toEqual(['t-1:fix']);
  });

  test('a later step of a journaled run continues the first thread, not by call order', async () => {
    // The implement step finished before the restart: the journal replays it
    // without calling the provider, so the fix is the first call.
    const { provider, followUps, launched } = journaledProvider({ threadIds: ['t-1'] });
    await provider.spawnAgent({ prompt: 'fix', cwd: '', execution: execution().info });
    expect(launched).toEqual([]);
    expect(followUps).toEqual(['t-1:fix']);
  });
});

describe('reopening a run', () => {
  beforeEach(async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  });

  test('a retry or take-over clears the journal, so the reopened attempt replays its threads', async () => {
    const settings = createFactorySettingsService();
    (await settings.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    const found = await settings.factoryId('alice', 'p1');
    if (found.isErr() || !found.value) throw new Error('no factory id');
    const factoryId = found.value;
    const runs = createFactoryRunsRepository();
    const run = (
      await runs.start({
        factoryId,
        issueNumber: 7,
        threadIds: ['t-1'],
        state: 'working',
      })
    )._unsafeUnwrap();
    const journal = createWorkflowJournalRepository();
    await journal.record({
      runId: run.id,
      nodeId: 'implement',
      visit: '1',
      attempt: 1,
      status: 'succeeded',
      startedAt: 1,
    });
    await runs.updateInFlight(run.id, { state: 'failed' });

    expect((await runs.reopen(run, ['t-1']))._unsafeUnwrap()).toBe('reopened');
    expect((await journal.load(run.id))._unsafeUnwrap()).toEqual([]);
  });
});
