import { describe, expect, test } from 'bun:test';

import type { ThreadStatus } from '@funny/shared';
import type { FactoryRun } from '@funny/shared/contracts/factory';

import { hasLaterRunOfIssue, latestLaterRunOfIssue, threadActivity } from '@/lib/thread-activity';

const thread = (status: ThreadStatus) => ({ status });
const run = (state: FactoryRun['state'], failureReason: string | null = null) => ({
  state,
  failureReason,
});

describe('threadActivity', () => {
  test('a thread without a factory run shows only its own status', () => {
    expect(threadActivity(thread('completed'), null)).toBe('none');
    expect(threadActivity(thread('completed'), undefined)).toBe('none');
  });

  test('a finished agent whose run still works (CI, PR, merge) reads as factory activity', () => {
    for (const state of ['queued', 'working', 'pr_open', 'waiting_ci', 'fixing'] as const) {
      expect(threadActivity(thread('completed'), run(state))).toBe('factory');
    }
    expect(threadActivity(thread('failed'), run('waiting_ci'))).toBe('factory');
  });

  test('a run parked for the member asks for attention', () => {
    expect(threadActivity(thread('completed'), run('waiting_human'))).toBe('factory-attention');
  });

  test('a pipeline stopped on an error reads as failed: failed, or parked after a failure', () => {
    expect(threadActivity(thread('completed'), run('failed', 'merge conflict'))).toBe(
      'factory-failed',
    );
    expect(threadActivity(thread('completed'), run('failed'))).toBe('factory-failed');
    expect(threadActivity(thread('completed'), run('waiting_human', 'wait_ci failed'))).toBe(
      'factory-failed',
    );
  });

  test('a run the agent is working on again shows the agent, even after a failure', () => {
    expect(threadActivity(thread('running'), run('waiting_human', 'wait_ci failed'))).toBe('none');
  });

  test('the agent own busy status wins over the run', () => {
    for (const status of ['running', 'setting_up', 'pending', 'waiting'] as const) {
      expect(threadActivity(thread(status), run('fixing'))).toBe('none');
      expect(threadActivity(thread(status), run('waiting_human'))).toBe('none');
    }
  });

  test('a run stopped after a failure still reads as failed', () => {
    expect(
      threadActivity(
        thread('completed'),
        run('stopped', 'Regression proof failed: Tests fail on the head commit'),
      ),
    ).toBe('factory-failed');
  });

  test('a run that ended without a merge and without an error does not read as done', () => {
    expect(threadActivity(thread('completed'), run('stopped'))).toBe('factory-ended');
    // The agent found nothing to change: not an error, but not a merge either.
    expect(threadActivity(thread('completed'), run('no_change'))).toBe('factory-ended');
  });

  test('a merged or queued run adds nothing', () => {
    for (const state of ['merged', 'requested'] as const) {
      expect(threadActivity(thread('completed'), run(state))).toBe('none');
    }
  });
});

describe('hasLaterRunOfIssue', () => {
  const r = (id: string, issueNumber: number, startedAt: string, factoryId = 'f1') => ({
    id,
    factoryId,
    issueNumber,
    startedAt,
  });
  const old = r('a', 434, '2026-11-23T22:02:14.146Z');

  test('the same issue sent again to the same factory later', () => {
    expect(hasLaterRunOfIssue([old, r('b', 434, '2026-11-23T22:56:22.751Z')], old)).toBe(true);
  });

  test('not an earlier run, another issue, another factory or the run itself', () => {
    expect(
      hasLaterRunOfIssue(
        [
          old,
          r('b', 434, '2026-11-23T21:00:00.000Z'),
          r('c', 435, '2026-11-23T23:00:00.000Z'),
          r('d', 434, '2026-11-23T23:00:00.000Z', 'f2'),
        ],
        old,
      ),
    ).toBe(false);
  });
});

describe('latestLaterRunOfIssue', () => {
  const r = (id: string, issueNumber: number | null, startedAt: string, factoryId = 'f1') => ({
    id,
    factoryId,
    issueNumber,
    startedAt,
  });
  const old = r('a', 434, '2026-11-23T22:02:14.146Z');

  test('the newest later run of the same issue in the same factory', () => {
    const later = r('b', 434, '2026-11-23T22:56:22.751Z');
    const latest = r('c', 434, '2026-11-24T01:00:00.000Z');
    expect(latestLaterRunOfIssue([latest, later, old], old)).toBe(latest);
    expect(latestLaterRunOfIssue([later, latest, old], old)).toBe(latest);
  });

  test('null for an earlier run, another issue, another factory, or a run without an issue', () => {
    const runs = [
      old,
      r('b', 434, '2026-11-23T21:00:00.000Z'),
      r('c', 435, '2026-11-24T01:00:00.000Z'),
      r('d', 434, '2026-11-24T01:00:00.000Z', 'f2'),
    ];
    expect(latestLaterRunOfIssue(runs, old)).toBeNull();
    const issueless = r('e', null, '2026-11-23T20:00:00.000Z');
    expect(
      latestLaterRunOfIssue([issueless, r('f', null, '2026-11-24T01:00:00.000Z')], issueless),
    ).toBeNull();
  });
});
