/**
 * Which pull request a member may close because a newer run of the issue
 * replaced its run: the server's own decision, from its rows.
 */
import { describe, expect, test } from 'bun:test';

import {
  replacedPullRequest,
  replacementOf,
} from '../../../services/factory/factory-replaced-pr.js';

type Run = Parameters<typeof replacedPullRequest>[0];

const run = (over: Partial<Run> & { id: string }): Run => ({
  issueNumber: 489,
  state: 'stopped',
  prUrl: null,
  startedAt: '2026-11-24T10:00:00.000Z',
  ...over,
});

const old = run({ id: 'aaaaaaaa-1111', prUrl: 'https://github.com/o/r/pull/506' });
const newer = run({
  id: 'bbbbbbbb-2222',
  state: 'merged',
  prUrl: 'https://github.com/o/r/pull/511',
  startedAt: '2026-11-25T07:00:00.000Z',
});

describe('replacementOf', () => {
  test('is the newest later run of the same issue', () => {
    const middle = run({ id: 'cccccccc-3333', startedAt: '2026-11-24T20:00:00.000Z' });
    expect(replacementOf(old, [old, middle, newer])?.id).toBe(newer.id);
    expect(replacementOf(newer, [old, middle, newer])).toBeNull();
  });

  test('ignores other issues, and runs without an issue', () => {
    const other = run({ id: 'dddddddd-4444', issueNumber: 490, startedAt: newer.startedAt });
    expect(replacementOf(old, [old, other])).toBeNull();
    const issueless = run({ id: 'eeeeeeee-5555', issueNumber: null });
    const later = run({ id: 'ffffffff-6666', issueNumber: null, startedAt: newer.startedAt });
    expect(replacementOf(issueless, [issueless, later])).toBeNull();
  });
});

describe('replacedPullRequest', () => {
  test('a stopped run a newer run replaced gives its pull request, its branch and the replacement', () => {
    expect(replacedPullRequest(old, [old, newer])._unsafeUnwrap()).toEqual({
      number: 506,
      branch: 'factory/issue-489-aaaaaaaa',
      by: { issueNumber: 489, prNumber: 511 },
    });
  });

  test('the newest run of an issue is never closed', () => {
    expect(replacedPullRequest(newer, [old, newer]).isErr()).toBe(true);
    expect(replacedPullRequest(old, [old]).isErr()).toBe(true);
  });

  test('a replaced run that may still merge is refused', () => {
    for (const state of ['waiting_human', 'waiting_ci', 'working', 'merged'] as const) {
      const live = { ...old, state };
      expect(replacedPullRequest(live, [live, newer]).isErr()).toBe(true);
    }
    const failed = { ...old, state: 'failed' as const };
    expect(replacedPullRequest(failed, [failed, newer]).isOk()).toBe(true);
  });

  test("a run without a pull request, or sharing the newer run's, is refused", () => {
    const none = { ...old, prUrl: null };
    expect(replacedPullRequest(none, [none, newer]).isErr()).toBe(true);
    const same = { ...newer, prUrl: old.prUrl };
    expect(replacedPullRequest(old, [old, same]).isErr()).toBe(true);
  });

  test('a replacement with no pull request yet is named without one', () => {
    const pending = { ...newer, prUrl: null };
    expect(replacedPullRequest(old, [old, pending])._unsafeUnwrap().by).toEqual({
      issueNumber: 489,
      prNumber: null,
    });
  });
});
