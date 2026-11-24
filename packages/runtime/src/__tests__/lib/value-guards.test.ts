import { describe, expect, test } from 'bun:test';

import {
  isBigInt,
  isBoolean,
  isNonEmptyString,
  isNumber,
  isObject,
  isPlainObject,
  isString,
  isSymbol,
} from '../../lib/value-guards.js';

// Each guard replaces an inline `typeof` check, so it must accept and refuse
// exactly what that check did.
const SAMPLES = [
  '',
  'text',
  0,
  Number.NaN,
  true,
  10n,
  Symbol('s'),
  null,
  undefined,
  {},
  [],
  () => 1,
] as const;

describe('value guards', () => {
  test.each([
    ['isString', isString, 'string'],
    ['isNumber', isNumber, 'number'],
    ['isBoolean', isBoolean, 'boolean'],
    ['isBigInt', isBigInt, 'bigint'],
    ['isSymbol', isSymbol, 'symbol'],
  ] as const)('%s matches typeof %s', (_name, guard, type) => {
    for (const sample of SAMPLES) expect(guard(sample)).toBe(typeof sample === type);
  });

  test('isNonEmptyString refuses the empty string and non-strings', () => {
    expect(SAMPLES.filter(isNonEmptyString)).toEqual(['text']);
  });

  test('isObject accepts non-null objects, arrays included, and not functions', () => {
    for (const sample of SAMPLES) {
      expect(isObject(sample)).toBe(typeof sample === 'object' && sample !== null);
    }
    expect(isObject([])).toBe(true);
    expect(isObject(null)).toBe(false);
  });

  test('isPlainObject refuses arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(() => 1)).toBe(false);
  });
});
