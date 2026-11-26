/**
 * Closing an issue whose work went to other issues once they are all closed
 * (issue #464: its run ended `done`, the issue stayed open, and #465, which it
 * blocks, waited on a person to close it).
 */
import { describe, expect, test } from 'bun:test';

import type { GithubCallError } from '@funny/core/github-app';
import type { FactoryTriage } from '@funny/shared/contracts/factory';
import { errAsync, okAsync } from 'neverthrow';

import {
  closeFinishedParents,
  parentsToCheck,
  type ParentCloseDeps,
} from '../../../services/factory/factory-parent-close.js';
import type { FactoryRunView } from '../../../services/factory/factory-runs-model.js';

const reader = { repo: 'o/r', ownerId: 'u1', projectId: 'p1' };
const AT = '2026-11-25T10:00:00.000Z';

const tracked: FactoryTriage = { decision: 'too_big', at: AT, items: [], existing: [542, 544] };

const run = (over: Partial<FactoryRunView> & { id: string }): FactoryRunView =>
  ({ issueNumber: 464, state: 'done', triage: tracked, ...over }) as FactoryRunView;

/** A GitHub where `closed` issues are closed, `unreadable` ones fail to read. */
function harness(input: { closed: number[]; unreadable?: number[]; closeFails?: boolean }) {
  const closed = new Set(input.closed);
  const calls = { comments: [] as number[], closes: [] as number[], activities: 0 };
  const marked: Array<{ runId: string; triage: FactoryTriage }> = [];
  const failure = { message: 'boom' } as GithubCallError;
  const deps: ParentCloseDeps = {
    github: {
      getIssue: (_reader, number) =>
        input.unreadable?.includes(number)
          ? errAsync(failure)
          : okAsync({
              number,
              title: '',
              url: '',
              state: closed.has(number) ? 'closed' : 'open',
            }),
      commentOnIssue: (_reader, number) => {
        calls.comments.push(number);
        return okAsync(undefined);
      },
      closeIssue: (_reader, number) => {
        if (input.closeFails) return errAsync(failure);
        calls.closes.push(number);
        closed.add(number);
        return okAsync(undefined);
      },
    },
    activities: {
      recordServerActivity: async () => {
        calls.activities += 1;
        return null as never;
      },
    },
    recordTriage: async (runId, triage) => {
      marked.push({ runId, triage });
    },
    now: () => AT,
  };
  return { deps, calls, marked };
}

describe('closeFinishedParents', () => {
  test('leaves the issue open while one of its parts is open', async () => {
    const h = harness({ closed: [542] });
    await closeFinishedParents(h.deps, reader, [run({ id: 'r1' })]);
    expect(h.calls.closes).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  test('closes the issue, says why and marks the run once every part is closed', async () => {
    const h = harness({ closed: [542, 544] });
    await closeFinishedParents(h.deps, reader, [run({ id: 'r1' })]);
    expect(h.calls.comments).toEqual([464]);
    expect(h.calls.closes).toEqual([464]);
    expect(h.calls.activities).toBe(1);
    expect(h.marked).toEqual([{ runId: 'r1', triage: { ...tracked, partsClosedAt: AT } }]);
  });

  test('only marks an issue a person already closed', async () => {
    const h = harness({ closed: [542, 544, 464] });
    await closeFinishedParents(h.deps, reader, [run({ id: 'r1' })]);
    expect(h.calls.closes).toEqual([]);
    expect(h.calls.comments).toEqual([]);
    expect(h.marked).toHaveLength(1);
  });

  test('looks again next pass when a part cannot be read or GitHub refuses the close', async () => {
    const unreadable = harness({ closed: [542], unreadable: [544] });
    await closeFinishedParents(unreadable.deps, reader, [run({ id: 'r1' })]);
    expect(unreadable.marked).toEqual([]);

    const refused = harness({ closed: [542, 544], closeFails: true });
    await closeFinishedParents(refused.deps, reader, [run({ id: 'r1' })]);
    expect(refused.marked).toEqual([]);
    expect(refused.calls.activities).toBe(0);
  });

  test('a split issue closes when the parts it opened are closed', async () => {
    const h = harness({ closed: [471, 472] });
    const triage: FactoryTriage = {
      decision: 'too_big',
      at: AT,
      items: ['a', 'b'],
      splitInto: [471, 472],
    };
    await closeFinishedParents(h.deps, reader, [run({ id: 'r1', issueNumber: 470, triage })]);
    expect(h.calls.closes).toEqual([470]);
  });
});

describe('parentsToCheck', () => {
  test("is each issue's latest run that handed its work away and is not marked yet", () => {
    const latest = run({ id: 'new' });
    const older = run({ id: 'old' });
    const marked = run({
      id: 'marked',
      issueNumber: 470,
      triage: { ...tracked, partsClosedAt: AT },
    });
    const ready = run({
      id: 'ready',
      issueNumber: 480,
      triage: { decision: 'ready', at: AT },
    });
    const parked = run({ id: 'parked', issueNumber: 490, state: 'needs_info' });
    expect(parentsToCheck([latest, older, marked, ready, parked]).map((r) => r.id)).toEqual([
      'new',
    ]);
  });
});
