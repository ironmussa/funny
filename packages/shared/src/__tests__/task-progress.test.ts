import { describe, expect, test } from 'bun:test';

import { parseTaskProgress } from '../task-progress';

describe('parseTaskProgress', () => {
  const run = { version: 1, title: 'lint', status: 'running', startedAt: 1, updatedAt: 2 };

  test('accepts a run and fills step and issue defaults', () => {
    const parsed = parseTaskProgress(
      JSON.stringify({ ...run, steps: [{ id: 'oxlint .', name: 'oxlint .', status: 'queued' }] }),
    );
    expect(parsed.ok && parsed.value).toMatchObject({
      issues: [],
      steps: [{ id: 'oxlint .', errors: 0, warnings: 0, tail: [] }],
    });
  });

  test('rejects another version, an unknown status, a bad issue and invalid JSON', () => {
    const steps: unknown[] = [];
    expect(parseTaskProgress(JSON.stringify({ ...run, version: 2, steps })).ok).toBe(false);
    expect(parseTaskProgress(JSON.stringify({ ...run, status: 'done', steps })).ok).toBe(false);
    const issues = [{ step: 'x', severity: 'fatal', message: 'm' }];
    expect(parseTaskProgress(JSON.stringify({ ...run, steps, issues })).ok).toBe(false);
    expect(parseTaskProgress('{').ok).toBe(false);
  });
});
