/**
 * Whether CI runs on the merge queue's branches (openspec factory-integration
 * 6.1, D12), read from a repository's GitHub Actions workflows.
 */
import { describe, expect, test } from 'bun:test';

import {
  ciRunsOnQueueBranches,
  readinessOf,
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

  test('CI on the queue branches and no rule against it: batches', () => {
    expect(readinessOf({ batchSize: 5, rules: open, workflows: pushes })).toEqual({
      mode: 'batches',
      queueCi: true,
      mergeQueueRequired: false,
      upToDateRequired: null,
      reasons: [],
    });
  });

  test("GitHub's required merge queue takes over", () => {
    expect(
      readinessOf({ batchSize: 5, rules: { ...open, mergeQueue: true }, workflows: pushes }).mode,
    ).toBe('host-queue');
  });

  test('one at a time, with each reason and what to change', () => {
    const readiness = readinessOf({
      batchSize: 5,
      rules: { ...open, upToDate: true },
      workflows: ['on: pull_request\n'],
    });
    expect(readiness.mode).toBe('serial');
    expect(readiness.reasons).toEqual([
      expect.stringContaining('up to date'),
      expect.stringContaining('factory/queue/**'),
    ]);
    expect(readinessOf({ batchSize: 1, rules: open, workflows: pushes }).reasons).toEqual([
      expect.stringContaining('batch size is 1'),
    ]);
    expect(readinessOf({ batchSize: 5, rules: null, workflows: null })).toMatchObject({
      mode: 'serial',
      queueCi: null,
      reasons: [expect.stringContaining('could not be read')],
    });
  });
});
