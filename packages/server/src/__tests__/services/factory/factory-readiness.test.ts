/**
 * Whether CI runs on the merge queue's branches (openspec factory-integration
 * 6.1, D12), read from a repository's GitHub Actions workflows.
 */
import { describe, expect, test } from 'bun:test';

import {
  ciRunsOnQueueBranches,
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
