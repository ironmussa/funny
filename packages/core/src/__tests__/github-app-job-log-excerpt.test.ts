/**
 * The excerpt of a failed GitHub Actions job that reaches a fix step and the
 * sentinel: why it failed, not the cleanup after it or the passing tests.
 */
import { describe, expect, test } from 'bun:test';

import { excerptOfJobLog } from '../github-app/pull-requests.js';

const stamp = (line: string) => `2026-11-23T02:02:23.4521673Z ${line}`;

describe('excerptOfJobLog', () => {
  test('a failure followed by a long cleanup keeps the failure', () => {
    const log = [
      'bun test',
      '(fail) rounding > keeps two decimals',
      'error: expect(received).toBe(expected)',
      '##[error]Process completed with exit code 1.',
      ...Array.from({ length: 400 }, (_, i) => `Post job cleanup ${i}: git config --unset-all`),
    ]
      .map(stamp)
      .join('\n');
    const excerpt = excerptOfJobLog(log);
    expect(excerpt).toContain('(fail) rounding > keeps two decimals');
    expect(excerpt).toContain('##[error]Process completed');
    expect(excerpt).not.toContain('Post job cleanup 399');
    // Timestamps are dropped to leave room for the log.
    expect(excerpt).not.toContain('2026-11-23T');
  });

  test('an error between tests far above the summary survives thousands of passing tests', () => {
    const log = [
      '# Unhandled error between tests',
      "SyntaxError: Export named 'lookupPRForBranch' not found in module 'git/index.ts'.",
      ...Array.from({ length: 3000 }, (_, i) => `(pass) suite > test number ${i} [0.1ms]`),
      ...Array.from({ length: 200 }, (_, i) => `[data-dir] noise line ${i}`),
      ' 2542 pass',
      ' 1 fail',
      'error: script "test" exited with code 1',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const excerpt = excerptOfJobLog(log);
    expect(excerpt).toContain("SyntaxError: Export named 'lookupPRForBranch'");
    expect(excerpt).toContain(' 1 fail');
    expect(excerpt).not.toContain('(pass)');
    expect(excerpt.length).toBeLessThanOrEqual(4_001);
  });

  test('a log without markers keeps its end, color codes removed', () => {
    const log = ['\u001b[31mboom\u001b[39m', ...Array.from({ length: 3 }, (_, i) => `line ${i}`)];
    expect(excerptOfJobLog(log.join('\n'))).toBe('boom\nline 0\nline 1\nline 2');
  });

  test('a single short failure line is kept as it is', () => {
    expect(excerptOfJobLog('FAIL src/x.test.ts')).toBe('FAIL src/x.test.ts');
  });
});
