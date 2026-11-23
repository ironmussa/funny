import { describe, expect, test } from 'bun:test';

import {
  blockingReviewFindings,
  contractOf,
  factoryReviewResultSchema,
  factoryTriageResultSchema,
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

describe('factoryTriageResultSchema', () => {
  const contract = { acceptanceCriteria: ['Negative numbers are summed'] };

  test('ready carries a contract; paths and hints default to none', () => {
    expect(factoryTriageResultSchema.parse({ decision: 'ready', contract })).toEqual({
      decision: 'ready',
      contract: { ...contract, likelyPaths: [], riskHints: [] },
    });
  });

  test('ready without acceptance criteria is refused', () => {
    expect(factoryTriageResultSchema.safeParse({ decision: 'ready' }).success).toBe(false);
    expect(
      factoryTriageResultSchema.safeParse({
        decision: 'ready',
        contract: { acceptanceCriteria: [] },
      }).success,
    ).toBe(false);
  });

  test('needs_info carries questions, too_big a split', () => {
    expect(
      factoryTriageResultSchema.parse({ decision: 'needs_info', questions: ['Which API?'] }),
    ).toEqual({ decision: 'needs_info', questions: ['Which API?'] });
    expect(
      factoryTriageResultSchema.parse({ decision: 'too_big', parts: ['Schema', 'UI'] }),
    ).toEqual({ decision: 'too_big', parts: ['Schema', 'UI'] });
    expect(factoryTriageResultSchema.safeParse({ decision: 'needs_info' }).success).toBe(false);
    expect(factoryTriageResultSchema.safeParse({ decision: 'too_big', parts: [] }).success).toBe(
      false,
    );
  });

  test('an unknown decision is refused', () => {
    expect(factoryTriageResultSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  test('a run has a contract only when triage was ready', () => {
    const at = '2026-11-22T00:00:00.000Z';
    const full = { ...contract, likelyPaths: [], riskHints: [] };
    expect(contractOf({ triage: { decision: 'ready', at, contract: full } })).toEqual(full);
    expect(contractOf({ triage: { decision: 'needs_info', at, items: ['?'] } })).toBeNull();
    expect(contractOf({ triage: { decision: 'none', at } })).toBeNull();
    expect(contractOf({ triage: null })).toBeNull();
  });
});
