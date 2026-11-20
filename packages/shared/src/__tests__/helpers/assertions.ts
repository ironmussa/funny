/**
 * Typed narrowing helpers for the shared package tests, so a test can reach a
 * narrower type through a runtime check instead of a type assertion.
 */
import { expect } from 'bun:test';

import type { DomainError } from '../../errors.js';

/** Fails the test unless `value` is an instance of `type`, and returns it narrowed. */
export function expectInstance<V, T>(value: V, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  if (!(value instanceof type)) throw new Error(`expected an instance of ${type.name}`);
  return value;
}

/** Fails the test unless `error` is the `type` variant of DomainError, and returns it narrowed. */
export function expectErrorType<K extends DomainError['type']>(
  error: DomainError,
  type: K,
): Extract<DomainError, { type: K }> {
  expect(error.type).toBe(type);
  if (!isErrorType(error, type)) throw new Error(`expected a ${type} error, got ${error.type}`);
  return error;
}

function isErrorType<K extends DomainError['type']>(
  error: DomainError,
  type: K,
): error is Extract<DomainError, { type: K }> {
  return error.type === type;
}
