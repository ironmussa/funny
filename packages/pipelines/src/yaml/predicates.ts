/**
 * JSONata-based predicate evaluation for YAML pipelines.
 *
 * Used wherever a YAML field declares a boolean condition:
 *   - node `when:` (skip the node if false)
 *   - loop `until:` (exit the loop when true)
 *   - retry `should_retry:` (retry only if true)
 *
 * String interpolation in templates is handled separately by Mustache —
 * see `interpolate.ts`. Splitting these two responsibilities is intentional:
 * predicates need rich query semantics (filtering, comparisons), templates
 * need clean output rendering. Bundling them into one engine produces awkward
 * trade-offs.
 *
 * JSONata reference: https://jsonata.org/
 */

import jsonata from 'jsonata';

import type { TemplateScope } from './interpolate.js';

export class PredicateError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = 'PredicateError';
  }
}

/**
 * Compile a JSONata expression once for reuse across multiple evaluations.
 * Use this when a predicate is evaluated many times (e.g. inside a loop).
 *
 * The compiled expression is opaque — call `evaluatePredicate` with it.
 */
export function compilePredicate(expression: string): CompiledPredicate {
  try {
    const compiled = jsonata(expression);
    return { evaluator: compiled, expression };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PredicateError(`Failed to compile predicate: ${message}`, expression);
  }
}

export interface CompiledPredicate {
  /** Internal JSONata expression handle. Don't access directly. */
  evaluator: ReturnType<typeof jsonata>;
  /** Original source for error messages. */
  expression: string;
}

/**
 * Evaluate a predicate against a scope. Returns the JSONata result coerced
 * to a boolean using JavaScript truthiness rules.
 *
 * @example
 *   await evaluatePredicate('verdict = "fail"', { verdict: 'fail' }) // true
 *   await evaluatePredicate('iteration > 10', { iteration: 5 })      // false
 *   await evaluatePredicate(
 *     'review.output.verdict = "pass"',
 *     { review: { output: { verdict: 'pass' } } },
 *   ) // true
 */
export async function evaluatePredicate(
  predicate: string | CompiledPredicate,
  scope: TemplateScope,
): Promise<boolean> {
  const compiled = isString(predicate) ? compilePredicate(predicate) : predicate;

  try {
    const result = await compiled.evaluator.evaluate(scope);
    return toBoolean(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PredicateError(`Predicate evaluation failed: ${message}`, compiled.expression);
  }
}

// ── Internal helpers ────────────────────────────────────────

function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function toBoolean(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isBoolean(value)) return value;
  if (isNumber(value)) return value !== 0 && !Number.isNaN(value);
  if (isString(value)) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}
