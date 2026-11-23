/**
 * Following GitHub's merge queue (factory-merge-lane `throughQueue`). Seen in a
 * real run (test-funny-queue #1): the queue merged the pull request, and one
 * reset connection while the factory looked at it again ended the run as failed.
 */
import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import {
  createMergeLane,
  type MergeLaneDeps,
} from '../../../services/factory/factory-merge-lane.js';
import type { FactoryPullRequestError } from '../../../services/factory/factory-pull-requests.js';

type Read = 'merged' | 'queued' | 'not-queued' | 'closed' | FactoryPullRequestError;

const unreachable: FactoryPullRequestError = {
  kind: 'github-error',
  message: 'GitHub unreachable: ECONNRESET',
};

const notReached = (): never => {
  throw new Error('throughQueue reached a pull request read it does not need');
};

function laneReading(reads: Read[]) {
  let read = 0;
  const lane = createMergeLane({
    prs: {
      enqueue: () => okAsync({ kind: 'queued' as const }),
      queueState: () => {
        const next = reads[Math.min(read++, reads.length - 1)]!;
        return typeof next === 'string' ? okAsync(next) : errAsync(next);
      },
      // throughQueue never reaches these: they fail the test if it does.
      pullHead: notReached,
      baseDistance: notReached,
      updateBranch: notReached,
      commitParents: notReached,
      baseChanges: notReached,
      changedFiles: notReached,
    },
    pullRequest: () => ({ repo: 'o/r', number: 2, userId: 'u1', projectId: 'p1' }),
    branch: 'factory/issue-1',
    signal: new AbortController().signal,
    waitChecks: async () => ({ ok: true }),
    sleep: async () => undefined,
  });
  return { throughQueue: () => lane.throughQueue('a'.repeat(40)), reads: () => read };
}

describe('following the merge queue', () => {
  test('a dropped connection while the queue merges is ridden out', async () => {
    const { throughQueue } = laneReading(['queued', unreachable, 'merged']);
    expect(await throughQueue()).toEqual({ kind: 'merged' });
  });

  test('a few in a row, then an answer, still ends with the answer', async () => {
    const { throughQueue } = laneReading([unreachable, unreachable, unreachable, 'merged']);
    expect(await throughQueue()).toEqual({ kind: 'merged' });
  });

  test('GitHub unreachable for good fails the step, after a bounded number of tries', async () => {
    const { throughQueue, reads } = laneReading([unreachable]);
    expect(await throughQueue()).toMatchObject({ kind: 'failed', error: unreachable.message });
    expect(reads()).toBe(6);
  });

  test('an access error is not retried', async () => {
    const denied: FactoryPullRequestError = { kind: 'no-access', message: 'The App has no access' };
    const { throughQueue, reads } = laneReading([denied, 'merged']);
    expect(await throughQueue()).toMatchObject({ kind: 'failed', error: denied.message });
    expect(reads()).toBe(1);
  });
});
