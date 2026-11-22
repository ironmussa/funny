import { describe, expect, test } from 'bun:test';

import {
  blockingReviewFindings,
  factoryReviewResultSchema,
  reviewAllowsMerge,
} from '../contracts/factory.js';

const SHA = 'a'.repeat(40);

describe('factoryReviewResultSchema', () => {
  test('accepts a pass without findings', () => {
    const parsed = factoryReviewResultSchema.parse({ sha: SHA, verdict: 'pass' });
    expect(parsed.findings).toEqual([]);
  });

  test('accepts findings with a severity and drops unknown fields', () => {
    const parsed = factoryReviewResultSchema.parse({
      sha: SHA,
      verdict: 'fail',
      confidence: 0.9,
      findings: [{ severity: 'high', title: 'Null deref', path: 'src/a.ts', line: 3 }],
    });
    expect(parsed).toEqual({
      sha: SHA,
      verdict: 'fail',
      findings: [{ severity: 'high', title: 'Null deref', path: 'src/a.ts', line: 3 }],
    });
  });

  test('refuses a result without the commit', () => {
    expect(factoryReviewResultSchema.safeParse({ verdict: 'pass' }).success).toBe(false);
  });

  test('refuses an empty commit', () => {
    expect(factoryReviewResultSchema.safeParse({ sha: ' ', verdict: 'pass' }).success).toBe(false);
  });

  test('refuses a result without a verdict', () => {
    expect(factoryReviewResultSchema.safeParse({ sha: SHA }).success).toBe(false);
  });

  test('refuses a finding with an unknown severity', () => {
    const result = factoryReviewResultSchema.safeParse({
      sha: SHA,
      verdict: 'fail',
      findings: [{ severity: 'blocker', title: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('reviewAllowsMerge', () => {
  const review = (verdict: 'pass' | 'fail', severities: string[]) =>
    factoryReviewResultSchema.parse({
      sha: SHA,
      verdict,
      findings: severities.map((severity) => ({ severity, title: severity })),
    });

  test('a pass allows it', () => {
    expect(reviewAllowsMerge(review('pass', ['high']))).toBe(true);
  });

  test('a fail with a critical or high finding blocks', () => {
    expect(reviewAllowsMerge(review('fail', ['low', 'high']))).toBe(false);
    expect(reviewAllowsMerge(review('fail', ['critical']))).toBe(false);
    expect(blockingReviewFindings(review('fail', ['low', 'high'])).map((f) => f.severity)).toEqual([
      'high',
    ]);
  });

  test('a fail with only lower findings is a pass with comments', () => {
    expect(reviewAllowsMerge(review('fail', ['medium', 'low']))).toBe(true);
  });

  test('a fail without findings blocks', () => {
    expect(reviewAllowsMerge(review('fail', []))).toBe(false);
  });
});
