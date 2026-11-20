/**
 * The factory's server provider on its own: replaying steps that continued the
 * same thread, and a thread whose launch raced a stop.
 */
import { describe, expect, test } from 'bun:test';

import { ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';

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

function providerWith(over: Partial<Parameters<typeof createFactoryActionProvider>[0]> = {}) {
  const waited: string[] = [];
  const deps = {
    scope,
    threadIds: new Array<string>(),
    prUrl: null,
    launchStartedAt: null,
    findLaunched: async () => null,
    launch: async () => ok({ thread: { id: 't-new' }, threadId: 't-new', runnerId: 'r' }),
    waitThread: async (threadId: string) => {
      waited.push(threadId);
      return { status: 'completed' as const, output: 'done' };
    },
    github: {
      findPullRequest: () => okAsync(null),
      pullRequests: {
        prState: () => okAsync('open' as const),
        ciState: () => okAsync({ kind: 'green' as const }),
        merge: () =>
          okAsync({ kind: 'merged' as const, method: 'squash' as const, branchDeleted: false }),
      },
    },
    record: async () => undefined,
    signal: new AbortController().signal,
    ...over,
  };
  return { provider: createFactoryActionProvider(deps), waited };
}

describe('factory action provider', () => {
  test('a replayed step that a later step continued on the same thread does not wait on it', async () => {
    const { provider, waited } = providerWith({ threadIds: ['A', 'A'] });
    // The implement step: the fix (step 2) already ran on A after it.
    expect(await provider.spawnAgent({ prompt: 'implement', cwd: '' })).toMatchObject({ ok: true });
    expect(waited).toEqual([]);
    // The last recorded step is the one still waited on.
    expect(await provider.spawnAgent({ prompt: 'fix', cwd: '' })).toMatchObject({ ok: true });
    expect(waited).toEqual(['A']);
  });

  test('a thread whose launch finished after the run was stopped is stopped', async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const { provider } = providerWith({
      signal: controller.signal,
      launch: async () => {
        controller.abort(); // the member clicked Stop while the runner was creating it
        return ok({ thread: { id: 't-late' }, threadId: 't-late', runnerId: 'r' });
      },
      waitThread: async () => ({ status: 'cancelled' as const }),
      abandon: async (threadId) => {
        abandoned.push(threadId);
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    expect(abandoned).toEqual(['t-late']);
  });

  test('an interrupted launch is adopted by the stable title prefix, not the full title', async () => {
    const prefixes: string[] = [];
    let launches = 0;
    const { provider } = providerWith({
      launchStartedAt: new Date().toISOString(),
      findLaunched: async (prefix) => {
        prefixes.push(prefix);
        return 't-orphan';
      },
      launch: async () => {
        launches++;
        return ok({ thread: {}, threadId: 't-new', runnerId: 'r' });
      },
    });
    await provider.spawnAgent({ prompt: 'implement', cwd: '' });
    expect(prefixes).toEqual(['[Factory] #7 ']);
    expect(launches).toBe(0);
  });
});
