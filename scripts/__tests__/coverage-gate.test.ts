import { describe, expect, test } from 'bun:test';

import { aggregateLineCoverage } from '../coverage-gate';

describe('aggregateLineCoverage', () => {
  test('reads the line column of the All files row', () => {
    const report = [
      '-----------|---------|---------|-------------------',
      'File       | % Funcs | % Lines | Uncovered Line #s',
      '-----------|---------|---------|-------------------',
      'All files  |   71.20 |   64.35 |',
      ' src/a.ts  |  100.00 |  100.00 |',
    ].join('\n');
    expect(aggregateLineCoverage(report)).toBe(64.35);
  });

  test('ignores ANSI colors', () => {
    expect(
      aggregateLineCoverage('\u001b[1mAll files\u001b[0m |  50.00 |  \u001b[33m42.10\u001b[0m |'),
    ).toBe(42.1);
  });

  test('is null without a summary row', () => {
    expect(aggregateLineCoverage('3 pass\n0 fail')).toBeNull();
  });
});
