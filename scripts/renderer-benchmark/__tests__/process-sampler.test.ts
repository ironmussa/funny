import { describe, expect, test } from 'bun:test';

import {
  aggregateDetailedProcessTree,
  aggregateProcessTree,
  classifyProcessRole,
  parseDetailedProcessTable,
  parseProcessTable,
} from '../process-sampler';

describe('process-tree sampler', () => {
  test('parses ps output and aggregates only descendants', () => {
    const records = parseProcessTable(
      [' 100 1 1024 2.5', ' 101 100 2048 3.5', ' 102 101 512 1.0', ' 200 1 9999 90.0'].join('\n'),
    );
    expect(aggregateProcessTree(100, records, 123)).toEqual({
      timestampMs: 123,
      processCount: 3,
      rssBytes: (1024 + 2048 + 512) * 1024,
      cpuPercent: 7,
    });
  });

  test('returns null when the root process has exited', () => {
    expect(aggregateProcessTree(999, [], 123)).toBeNull();
  });

  test('aggregates RSS by Chromium process role', () => {
    const records = parseDetailedProcessTable(
      [
        '100 1 1024 2.5 bun scripts/soak-client-memory.ts',
        '101 100 2048 3.5 /chrome/chrome --headless',
        '102 101 512 1.0 /chrome/chrome --type=renderer',
        '103 101 256 0.5 /chrome/chrome --type=gpu-process',
        '200 1 9999 90.0 /unrelated --type=renderer',
      ].join('\n'),
    );
    const sample = aggregateDetailedProcessTree(100, records, 123);

    expect(sample?.rssBytes).toBe((1024 + 2048 + 512 + 256) * 1024);
    expect(sample?.chromiumRssBytes).toBe((2048 + 512 + 256) * 1024);
    expect(sample?.rssBytesByRole).toMatchObject({
      harness: 1024 * 1024,
      browser: 2048 * 1024,
      renderer: 512 * 1024,
      gpu: 256 * 1024,
    });
    expect(sample?.processCountByRole).toMatchObject({
      harness: 1,
      browser: 1,
      renderer: 1,
      gpu: 1,
    });
  });

  test('classifies Chromium subprocesses before the browser process', () => {
    expect(classifyProcessRole('/chrome --type=renderer')).toBe('renderer');
    expect(classifyProcessRole('/chrome --type=utility --utility-sub-type=network')).toBe(
      'utility',
    );
    expect(classifyProcessRole('/chrome/chrome --headless')).toBe('browser');
    expect(classifyProcessRole('/chromium/chrome-headless-shell --headless')).toBe('browser');
    expect(classifyProcessRole('node playwright-driver')).toBe('harness');
  });
});
