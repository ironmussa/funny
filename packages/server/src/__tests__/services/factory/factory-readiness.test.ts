/**
 * Whether CI runs on the merge queue's branches (openspec factory-integration
 * 6.1, D12), read from a repository's GitHub Actions workflows.
 */
import { describe, expect, test } from 'bun:test';

import {
  ciRunsOnQueueBranches,
  laneCiWarning,
  lastMergeDriver,
  medianOf,
  readinessOf,
  workflowRunsOnLaneBranch,
  workflowRunsOnQueueBranches,
} from '../../../services/factory/factory-readiness.js';

describe('CI on the queue branches', () => {
  // ironmussa/test-funny's ci.yml: pull requests, and pushes to main only.
  test('pull requests and pushes to main only: a batch would never be tested', () => {
    expect(
      workflowRunsOnQueueBranches(`name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs: {}
`),
    ).toBe(false);
  });

  test('a push trigger with no branch filter, or one that matches, runs there', () => {
    expect(workflowRunsOnQueueBranches('on: push\njobs: {}\n')).toBe(true);
    expect(workflowRunsOnQueueBranches('on: [push, pull_request]\njobs: {}\n')).toBe(true);
    expect(workflowRunsOnQueueBranches('on:\n  push:\njobs: {}\n')).toBe(true);
    expect(
      workflowRunsOnQueueBranches("on:\n  push:\n    branches: [main, 'factory/queue/**']\n"),
    ).toBe(true);
    expect(workflowRunsOnQueueBranches("on:\n  push:\n    branches: ['**']\n")).toBe(true);
  });

  test('an ignored or excluded queue branch, or tags only, does not', () => {
    expect(workflowRunsOnQueueBranches("on:\n  push:\n    branches-ignore: ['factory/**']\n")).toBe(
      false,
    );
    expect(
      workflowRunsOnQueueBranches("on:\n  push:\n    branches: ['**', '!factory/queue/**']\n"),
    ).toBe(false);
    expect(workflowRunsOnQueueBranches("on:\n  push:\n    tags: ['v*']\n")).toBe(false);
    expect(workflowRunsOnQueueBranches('on: pull_request\n')).toBe(false);
    expect(workflowRunsOnQueueBranches('not: [valid')).toBe(false);
  });

  test('one workflow that runs there is enough', () => {
    expect(ciRunsOnQueueBranches(['on: pull_request\n', 'on: push\n'])).toBe(true);
    expect(ciRunsOnQueueBranches([])).toBe(false);
  });
});

describe('readiness', () => {
  const open = { mergeQueue: false, requiredChecks: [], upToDate: null };
  const pushes = ['on: push\n'];
  const timing = { batchWaitMs: 60_000, mergeDriver: null, medianCiMs: null } as const;

  test('CI on the queue branches and no rule against it: batches', () => {
    expect(readinessOf({ ...timing, batchSize: 5, rules: open, workflows: pushes })).toEqual({
      mode: 'batches',
      queueCi: true,
      mergeQueueRequired: false,
      upToDateRequired: null,
      mergeDriver: null,
      medianCiMs: null,
      batchWaitMs: 60_000,
      reasons: [],
      advice: [],
    });
  });

  test("GitHub's required merge queue takes over", () => {
    expect(
      readinessOf({
        ...timing,
        batchSize: 5,
        rules: { ...open, mergeQueue: true },
        workflows: pushes,
      }).mode,
    ).toBe('host-queue');
  });

  test('one at a time, with each reason and what to change', () => {
    const readiness = readinessOf({
      ...timing,
      batchSize: 5,
      rules: { ...open, upToDate: true },
      workflows: ['on: pull_request\n'],
    });
    expect(readiness.mode).toBe('serial');
    expect(readiness.reasons).toEqual([
      expect.stringContaining('up to date'),
      expect.stringContaining('factory/queue/**'),
    ]);
    expect(
      readinessOf({ ...timing, batchSize: 1, rules: open, workflows: pushes }).reasons,
    ).toEqual([expect.stringContaining('batch size is 1')]);
    expect(readinessOf({ ...timing, batchSize: 5, rules: null, workflows: null })).toMatchObject({
      mode: 'serial',
      queueCi: null,
      reasons: [expect.stringContaining('could not be read')],
    });
  });

  test('advice: no weave on the runner, a batch wait longer than CI; it never blocks', () => {
    const readiness = readinessOf({
      batchSize: 5,
      batchWaitMs: 600_000,
      mergeDriver: 'git',
      medianCiMs: 240_000,
      rules: open,
      workflows: pushes,
    });
    expect(readiness.mode).toBe('batches');
    expect(readiness.advice).toEqual([
      expect.stringContaining('weave'),
      expect.stringContaining('shorter batch wait'),
    ]);
    expect(
      readinessOf({
        batchSize: 5,
        batchWaitMs: 60_000,
        mergeDriver: 'weave',
        medianCiMs: 240_000,
        rules: open,
        workflows: pushes,
      }).advice,
    ).toEqual([]);
  });
});

describe('readiness inputs', () => {
  test('the median of the CI times; none before a batch', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([300, 100, 200])).toBe(200);
    expect(medianOf([100, 400, 200, 300])).toBe(250);
  });

  test('the merge driver of the newest run that integrated (runs newest first)', () => {
    const run = (integrateRounds: number, weaveIntegrations: number) => ({
      metrics: { integrateRounds, weaveIntegrations },
    });
    expect(lastMergeDriver([])).toBeNull();
    expect(lastMergeDriver([run(0, 0), run(2, 1)])).toBe('weave');
    expect(lastMergeDriver([run(1, 0), run(2, 2)])).toBe('git');
  });
});

describe('CI on a lane branch (openspec factory-lanes 4.5)', () => {
  test('pull_request or push filters that include the lane branch produce no warning', () => {
    expect(
      workflowRunsOnLaneBranch(
        "on:\n  pull_request:\n    branches: [main, 'feature/**']\n",
        'feature/auth',
      ),
    ).toBe(true);
    expect(workflowRunsOnLaneBranch('on:\n  pull_request:\n', 'feature/auth')).toBe(true);
    expect(
      workflowRunsOnLaneBranch("on:\n  push:\n    branches: ['feature/*']\n", 'feature/auth'),
    ).toBe(true);
    expect(
      laneCiWarning(["on:\n  pull_request:\n    branches: [main, 'feature/**']\n"], 'feature/auth'),
    ).toBeNull();
    expect(laneCiWarning([], 'feature/auth')).toBeNull();
    expect(laneCiWarning(null, 'feature/auth')).toBeNull();
  });

  test('workflows whose pull_request and push filters exclude the lane branch produce a warning', () => {
    const mainOnly = 'on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n';
    expect(workflowRunsOnLaneBranch(mainOnly, 'feature/auth')).toBe(false);
    expect(laneCiWarning([mainOnly], 'feature/auth')).toContain('feature/auth');

    const ignored = "on:\n  pull_request:\n    branches-ignore: ['feature/**']\n";
    expect(workflowRunsOnLaneBranch(ignored, 'feature/auth')).toBe(false);
    expect(laneCiWarning([ignored], 'feature/auth')).toContain('feature/auth');
  });
});
