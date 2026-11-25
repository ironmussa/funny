/**
 * Bringing the base in without waiting for checks (factory-merge-lane
 * `updateBase`, openspec factory-approval-survives-integration D1): what
 * `merge` does before it parks a high-risk change for a person.
 */
import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createMergeLane } from '../../../services/factory/factory-merge-lane.js';

const A = 'a'.repeat(40);
const BASE = 'f'.repeat(40);

type Update = 'updating' | 'conflict';

/**
 * A pull request `behind` commits behind its base. Each accepted update makes
 * a new head (a merge of the old one with the base); `movesAgain` puts the base
 * ahead again after each one.
 */
function laneOn(input: { behind: number; update?: Update; movesAgain?: boolean }) {
  let head = A;
  let behind = input.behind;
  let updates = 0;
  let checksWaited = 0;
  const parents = new Map<string, string[]>();
  const lane = createMergeLane({
    prs: {
      pullHead: () => okAsync({ sha: head, baseRef: 'main', autoMerge: false }),
      baseDistance: (_pr, _base, sha) =>
        okAsync(sha === BASE ? { behindBy: 0, aheadBy: 0 } : { behindBy: behind, aheadBy: 1 }),
      updateBranch: () => {
        if (input.update === 'conflict') {
          return okAsync({ kind: 'conflict' as const, reason: 'merge conflict' });
        }
        updates += 1;
        const next = String(updates).repeat(40);
        parents.set(next, [head, BASE]);
        head = next;
        behind = input.movesAgain ? 1 : 0;
        return okAsync({ kind: 'updating' as const });
      },
      commitParents: (_pr, sha) => okAsync(parents.get(sha) ?? []),
      baseChanges: () => okAsync({ commits: [], files: [] }),
      changedFiles: () => okAsync({ files: [], truncated: false }),
      enqueue: () => {
        throw new Error('updateBase does not use the merge queue');
      },
      queueState: () => {
        throw new Error('updateBase does not use the merge queue');
      },
    },
    pullRequest: () => ({ repo: 'o/r', number: 2, userId: 'u1', projectId: 'p1' }),
    branch: 'factory/issue-1',
    signal: new AbortController().signal,
    waitChecks: async () => {
      checksWaited += 1;
      return { ok: true };
    },
    sleep: async () => undefined,
  });
  return { lane, updates: () => updates, checksWaited: () => checksWaited };
}

describe('updateBase', () => {
  test('a head behind its base is updated, and its checks are not waited on', async () => {
    const { lane, updates, checksWaited } = laneOn({ behind: 3 });

    const result = await lane.updateBase();

    expect(result).toEqual({
      kind: 'current',
      sha: '1'.repeat(40),
      carried: [{ from: A, to: '1'.repeat(40) }],
    });
    expect(updates()).toBe(1);
    expect(checksWaited()).toBe(0);
  });

  test('a head that has its base asks GitHub for no update', async () => {
    const { lane, updates } = laneOn({ behind: 0 });

    expect(await lane.updateBase()).toEqual({ kind: 'current', sha: A, carried: [] });
    expect(updates()).toBe(0);
  });

  test('a conflict is sent back as code', async () => {
    const { lane } = laneOn({ behind: 2, update: 'conflict' });

    const result = await lane.updateBase();

    expect(result.kind).toBe('sent-back');
    expect(result.kind === 'sent-back' && result.why).toBe('conflict');
  });

  test('a base that keeps moving fails after a bounded number of updates', async () => {
    const { lane, updates } = laneOn({ behind: 1, movesAgain: true });

    const result = await lane.updateBase();

    expect(result.kind).toBe('failed');
    expect(updates()).toBe(5);
  });

  test('bringUpToDate still waits for the checks of the updated head', async () => {
    const { lane, checksWaited } = laneOn({ behind: 3 });

    expect((await lane.bringUpToDate()).kind).toBe('current');
    expect(checksWaited()).toBe(1);
  });
});
