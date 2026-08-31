import { describe, expect, test } from 'bun:test';

import { aggregateProcessTree, parseProcessTable } from '../process-sampler';

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
});
