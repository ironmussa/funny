import { describe, expect, test } from 'bun:test';

import type { AutomationRun, InboxItem, RunTriageStatus } from '@funny/shared';
import { DEFAULT_PROVIDER, getDefaultModel } from '@funny/shared/models';

import {
  countBy,
  findingsOf,
  hasActiveInboxFilters,
  matchesInboxCriteria,
  toggledSet,
  type InboxCriteria,
} from './inbox-filter-logic';

function item(overrides: {
  triageStatus?: RunTriageStatus;
  hasFindings?: boolean;
  status?: AutomationRun['status'];
  automationId?: string;
  automationName?: string;
  title?: string;
}): InboxItem {
  const automationId = overrides.automationId ?? 'a1';
  return {
    run: {
      id: 'r1',
      automationId,
      threadId: 't1',
      status: overrides.status ?? 'completed',
      triageStatus: overrides.triageStatus ?? 'pending',
      hasFindings: overrides.hasFindings ?? false,
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    automation: {
      id: automationId,
      projectId: 'p1',
      userId: 'u1',
      name: overrides.automationName ?? 'Nightly audit',
      prompt: 'Audit the repository',
      schedule: '0 * * * *',
      provider: DEFAULT_PROVIDER,
      model: getDefaultModel(DEFAULT_PROVIDER),
      mode: 'local',
      permissionMode: 'autoEdit',
      enabled: true,
      maxRunHistory: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    thread: { id: 't1', projectId: 'p1', title: overrides.title ?? 'Check the build' },
  };
}

function criteria(overrides: Partial<InboxCriteria> = {}): InboxCriteria {
  return {
    status: 'all',
    findings: new Set(),
    runStates: new Set(),
    automations: new Set(),
    needle: '',
    caseSensitive: false,
    ...overrides,
  };
}

describe('matchesInboxCriteria', () => {
  test('empty criteria match every run', () => {
    expect(matchesInboxCriteria(item({ triageStatus: 'dismissed' }), criteria())).toBe(true);
  });

  test('a status keeps only runs with that triage status', () => {
    const c = criteria({ status: 'reviewed' });
    expect(matchesInboxCriteria(item({ triageStatus: 'reviewed' }), c)).toBe(true);
    expect(matchesInboxCriteria(item({ triageStatus: 'pending' }), c)).toBe(false);
  });

  test('the findings chips match by whether the run has findings', () => {
    const c = criteria({ findings: new Set(['with']) });
    expect(matchesInboxCriteria(item({ hasFindings: true }), c)).toBe(true);
    expect(matchesInboxCriteria(item({ hasFindings: false }), c)).toBe(false);
  });

  test('the run state chips match the run status', () => {
    const c = criteria({ runStates: new Set(['failed', 'running']) });
    expect(matchesInboxCriteria(item({ status: 'failed' }), c)).toBe(true);
    expect(matchesInboxCriteria(item({ status: 'completed' }), c)).toBe(false);
  });

  test('the automation chips match the automation id', () => {
    const c = criteria({ automations: new Set(['a2']) });
    expect(matchesInboxCriteria(item({ automationId: 'a2' }), c)).toBe(true);
    expect(matchesInboxCriteria(item({ automationId: 'a1' }), c)).toBe(false);
  });

  test('the search matches the automation name or the thread title', () => {
    const c = criteria({ needle: 'audit' });
    expect(matchesInboxCriteria(item({ automationName: 'Nightly AUDIT', title: 'x' }), c)).toBe(
      true,
    );
    expect(matchesInboxCriteria(item({ automationName: 'x', title: 'Audit result' }), c)).toBe(
      true,
    );
    expect(matchesInboxCriteria(item({ automationName: 'x', title: 'y' }), c)).toBe(false);
  });

  test('a case-sensitive search does not fold case', () => {
    const c = criteria({ needle: 'audit', caseSensitive: true });
    expect(matchesInboxCriteria(item({ automationName: 'AUDIT', title: 'x' }), c)).toBe(false);
  });

  test('every criterion must hold', () => {
    const c = criteria({ status: 'pending', runStates: new Set(['failed']) });
    expect(matchesInboxCriteria(item({ triageStatus: 'pending', status: 'completed' }), c)).toBe(
      false,
    );
  });
});

describe('hasActiveInboxFilters', () => {
  test('the defaults are not active filters', () => {
    expect(hasActiveInboxFilters(null, 'pending', [new Set(), new Set()])).toBe(false);
  });

  test('a project, another status or a chosen chip is', () => {
    expect(hasActiveInboxFilters('p1', 'pending', [new Set()])).toBe(true);
    expect(hasActiveInboxFilters(null, 'all', [new Set()])).toBe(true);
    expect(hasActiveInboxFilters(null, 'pending', [new Set(), new Set(['with'])])).toBe(true);
  });
});

describe('helpers', () => {
  test('toggledSet adds a missing value and removes a present one, on a copy', () => {
    const start = new Set(['a']);
    expect([...toggledSet(start, 'b')]).toEqual(['a', 'b']);
    expect([...toggledSet(start, 'a')]).toEqual([]);
    expect([...start]).toEqual(['a']);
  });

  test('countBy counts items per key', () => {
    expect(countBy(['a', 'b', 'a'], (v) => v)).toEqual({ a: 2, b: 1 });
  });

  test('findingsOf names the findings chip of a run', () => {
    expect(findingsOf(item({ hasFindings: true }))).toBe('with');
    expect(findingsOf(item({ hasFindings: false }))).toBe('without');
  });
});
