import { describe, expect, test } from 'bun:test';

import { parseTestProgress, parseTestProgressFence } from '../test-progress';

describe('parseTestProgress', () => {
  test('accepts a run and fills suite defaults', () => {
    const parsed = parseTestProgress(
      JSON.stringify({
        version: 1,
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        suites: [{ name: '@x/a', status: 'queued' }],
      }),
    );
    expect(parsed.ok && parsed.value.suites[0]).toEqual({
      name: '@x/a',
      status: 'queued',
      related: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      running: [],
      slow: [],
      failures: [],
      files: [],
    });
  });

  test('rejects another version, an unknown status and invalid JSON', () => {
    const run = { status: 'running', startedAt: 1, updatedAt: 2, suites: [] };
    expect(parseTestProgress(JSON.stringify({ ...run, version: 2 })).ok).toBe(false);
    expect(parseTestProgress(JSON.stringify({ ...run, version: 1, status: 'done' })).ok).toBe(
      false,
    );
    expect(parseTestProgress('{').ok).toBe(false);
  });
});

describe('parseTestProgressFence', () => {
  test('reads `{ "path" }` or a bare absolute path', () => {
    expect(parseTestProgressFence('{"path": "/tmp/p.json"}')).toBe('/tmp/p.json');
    expect(parseTestProgressFence('  /tmp/p.json\n')).toBe('/tmp/p.json');
  });

  test('anything else is null', () => {
    expect(parseTestProgressFence('relative/p.json')).toBeNull();
    expect(parseTestProgressFence('{"file": "/tmp/p.json"}')).toBeNull();
    expect(parseTestProgressFence('')).toBeNull();
  });
});
