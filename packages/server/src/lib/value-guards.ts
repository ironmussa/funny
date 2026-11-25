/**
 * Type guards for values the server reads from runners, sockets and
 * third-party libraries before they have a declared type. Each guard is one
 * `typeof` check (the `anti-slop/no-runtime-typeof` rule allows them only in
 * a `value is T` guard), so call sites branch on a named, typed result. They
 * narrow exactly like the inline `typeof` they replace.
 */

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isBigInt(value: unknown): value is bigint {
  return typeof value === 'bigint';
}

export function isSymbol(value: unknown): value is symbol {
  return typeof value === 'symbol';
}

/** Any non-null object, arrays included (`typeof value === 'object' && value !== null`). */
export function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

/** A non-null object that is not an array; the caller's array members are dropped from its type. */
export function isPlainObject<T>(value: T): value is Exclude<T, readonly unknown[]> & object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
