/**
 * Which implement thread a retry goes on with (`keepsItsCheckout`). Found on
 * run #479: an earlier retry had removed the thread's worktree, the next one
 * kept the thread anyway, and its `integrate` ran in the project's own checkout.
 */
import { describe, expect, test } from 'bun:test';

import { keepsItsCheckout } from '../../../services/factory/factory-run-control.js';

const RUN_BRANCH = 'factory/issue-479-bbd471c3';
const thread = (over: Partial<Parameters<typeof keepsItsCheckout>[0]> = {}) => ({
  worktreePath: '/worktrees/factory-issue-479-bbd471c3',
  branch: RUN_BRANCH,
  mode: 'worktree',
  runtime: 'local',
  ...over,
});

describe('keepsItsCheckout', () => {
  test("a worktree on the run's branch is kept", () => {
    expect(keepsItsCheckout(thread(), RUN_BRANCH)).toBe(true);
  });

  test('a worktree put on another branch is not', () => {
    expect(keepsItsCheckout(thread({ branch: 'funny/factory-479-title' }), RUN_BRANCH)).toBe(false);
  });

  test('a worktree thread whose worktree was removed is not', () => {
    expect(keepsItsCheckout(thread({ worktreePath: null, branch: null }), RUN_BRANCH)).toBe(false);
  });

  test('a sandbox thread and a local-mode thread, which record no worktree, are kept', () => {
    const none = { worktreePath: null, branch: null };
    expect(keepsItsCheckout(thread({ ...none, runtime: 'sandbox' }), RUN_BRANCH)).toBe(true);
    expect(keepsItsCheckout(thread({ ...none, mode: 'local' }), RUN_BRANCH)).toBe(true);
  });
});
