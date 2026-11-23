import { describe, expect, test } from 'bun:test';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';
import {
  factoryRunSteps,
  filterFactoryRuns,
  groupFactoryRuns,
  isFactoryRunFailed,
  isFactoryRunNoChange,
  isFactoryRunUnsavedWork,
} from '@/lib/factory-run-labels';

describe('groupFactoryRuns (the factory view)', () => {
  test('groups runs by what the member sees, the ended ones last', () => {
    const run = (id: string, state: FactoryRun['state'], queueOrder: number | null = null) =>
      buildFactoryRun({ id, state, queueOrder });
    const groups = groupFactoryRuns([
      run('parked', 'waiting_human'),
      run('ci', 'waiting_ci'),
      run('admitted', 'queued'),
      run('second', 'requested', 2),
      run('first', 'requested', 1),
      run('broken', 'failed'),
      run('done', 'merged'),
      run('cancelled', 'stopped'),
      run('nothing-to-do', 'no_change'),
    ]);
    const ids = (key: keyof typeof groups) => groups[key].map((r) => r.id);
    expect(ids('waiting')).toEqual(['parked']);
    expect(ids('active')).toEqual(['ci', 'admitted']);
    // The queue follows its own order, not the list's.
    expect(ids('queue')).toEqual(['first', 'second']);
    expect(ids('failed')).toEqual(['broken']);
    expect(ids('ended')).toEqual(['done', 'cancelled', 'nothing-to-do']);
  });
});

describe('a run that ended with no change', () => {
  const steps = ['implement', 'pull-request', 'ci', 'merge'];

  test('is over without a failure: the steps after the agent stay pending', () => {
    const run = buildFactoryRun({
      state: 'no_change',
      currentStep: 'pull-request',
      flowSteps: steps,
      failureReason: null,
    });
    expect(isFactoryRunNoChange(run)).toBe(true);
    expect(isFactoryRunFailed(run)).toBe(false);
    expect(factoryRunSteps(run).map((step) => step.status)).toEqual([
      'done',
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('is told apart from a run parked with unsaved work in its checkout', () => {
    const parked = buildFactoryRun({
      state: 'waiting_human',
      currentStep: 'pull-request',
      flowSteps: steps,
      failureReason: 'no change',
    });
    expect(isFactoryRunUnsavedWork(parked)).toBe(true);
    expect(isFactoryRunNoChange(parked)).toBe(false);
  });
});

describe('filterFactoryRuns (the factory view)', () => {
  const runs = [
    { ...buildFactoryRun({ id: 'a', issueNumber: 12, state: 'merged' }), projectId: 'p1' },
    {
      ...buildFactoryRun({ id: 'b', issueNumber: 7, state: 'working', currentStep: 'Implement' }),
      projectId: 'p2',
    },
    { ...buildFactoryRun({ id: 'c', issueNumber: 30, state: 'requested' }), projectId: 'p1' },
  ];
  const projectNameById = new Map([
    ['p1', 'Funny'],
    ['p2', 'Other'],
  ]);
  const ids = (
    search: string,
    opts: { caseSensitive?: boolean; states?: string[]; projectIds?: string[] } = {},
  ) =>
    filterFactoryRuns(runs, {
      search,
      caseSensitive: opts.caseSensitive ?? false,
      states: new Set(opts.states ?? []),
      projectIds: new Set(opts.projectIds ?? []),
      projectNameById,
    }).map((run) => run.id);

  test('keeps every run in the view order without a filter', () => {
    expect(ids('')).toEqual(['b', 'c', 'a']);
  });

  test('matches the issue number (with or without #), the project and the step', () => {
    expect(ids('#12')).toEqual(['a']);
    expect(ids('funny')).toEqual(['c', 'a']);
    expect(ids('implement')).toEqual(['b']);
    expect(ids('implement', { caseSensitive: true })).toEqual([]);
  });

  test('keeps only the chosen states', () => {
    expect(ids('', { states: ['merged', 'requested'] })).toEqual(['c', 'a']);
  });

  test('keeps only the chosen projects, combined with the other filters', () => {
    expect(ids('', { projectIds: ['p2'] })).toEqual(['b']);
    expect(ids('', { projectIds: ['p1', 'p2'] })).toEqual(['b', 'c', 'a']);
    expect(ids('', { projectIds: ['p1'], states: ['merged'] })).toEqual(['a']);
  });
});
