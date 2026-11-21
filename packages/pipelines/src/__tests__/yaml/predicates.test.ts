/**
 * JSONata predicate evaluation tests.
 *
 * Covers: simple comparisons, dot-path navigation, array filtering,
 * boolean operators, truthy coercion, compile-then-reuse, and error
 * surfacing on invalid expressions.
 */

import { describe, expect, test } from 'bun:test';

import { compilePredicate, evaluatePredicate, PredicateError } from '../../yaml/predicates.js';

describe('evaluatePredicate (async)', () => {
  test('evaluates a simple equality', async () => {
    expect(await evaluatePredicate('verdict = "fail"', { verdict: 'fail' })).toBe(true);
    expect(await evaluatePredicate('verdict = "fail"', { verdict: 'pass' })).toBe(false);
  });

  test('evaluates dot-path against nested objects', async () => {
    expect(
      await evaluatePredicate('review.output.verdict = "pass"', {
        review: { output: { verdict: 'pass' } },
      }),
    ).toBe(true);
  });

  test('evaluates boolean operators', async () => {
    expect(await evaluatePredicate('a = 1 and b = 2', { a: 1, b: 2 })).toBe(true);
    expect(await evaluatePredicate('a = 1 or b = 99', { a: 5, b: 99 })).toBe(true);
  });

  test('evaluates numeric comparisons', async () => {
    expect(await evaluatePredicate('iteration > 5', { iteration: 10 })).toBe(true);
    expect(await evaluatePredicate('iteration > 5', { iteration: 3 })).toBe(false);
  });

  test('returns false for missing paths (truthy coercion)', async () => {
    expect(await evaluatePredicate('absent = "yes"', {})).toBe(false);
    expect(await evaluatePredicate('absent', {})).toBe(false);
  });

  test('coerces non-empty arrays as truthy', async () => {
    // JSONata sequences: a non-empty array path is truthy when used bare.
    expect(await evaluatePredicate('findings', { findings: ['a'] })).toBe(true);
    expect(await evaluatePredicate('findings', { findings: [] })).toBe(false);
  });

  test('filters arrays', async () => {
    // Useful for "any critical findings?"
    expect(
      await evaluatePredicate('$count(findings[severity = "critical"]) > 0', {
        findings: [{ severity: 'low' }, { severity: 'critical' }],
      }),
    ).toBe(true);

    expect(
      await evaluatePredicate('$count(findings[severity = "critical"]) > 0', {
        findings: [{ severity: 'low' }, { severity: 'medium' }],
      }),
    ).toBe(false);
  });

  test('throws PredicateError on invalid expression', async () => {
    await expect(evaluatePredicate('verdict ===', {})).rejects.toThrow(PredicateError);
  });

  test('compiled predicate can be reused', async () => {
    const compiled = compilePredicate('verdict = "pass"');
    expect(await evaluatePredicate(compiled, { verdict: 'pass' })).toBe(true);
    expect(await evaluatePredicate(compiled, { verdict: 'fail' })).toBe(false);
  });
});

describe('compilePredicate', () => {
  test('throws PredicateError on invalid expression at compile time', () => {
    expect(() => compilePredicate('!@#$ broken')).toThrow(PredicateError);
  });
});
