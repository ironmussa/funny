function isNonNullObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

/** A value that is not an object: what a canonical copy keeps as it is. */
type CanonicalLeaf =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined
  | ((...args: never[]) => void);

/** A canonical copy for JSON.stringify: arrays and objects rebuilt (keys sorted), leaves as given. */
export type CanonicalValue = CanonicalLeaf | CanonicalValue[] | { [key: string]: CanonicalValue };

/** The value as a leaf, once it is known to be neither an array nor a non-null object. */
export function asCanonicalLeaf<T>(value: T): CanonicalLeaf {
  // SAFETY: callers pass only values that failed both the Array.isArray and the non-null
  // object check, so `value` is a primitive, null, undefined or a function.
  return value as CanonicalLeaf;
}

function canonicalize<T>(value: T): CanonicalValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isNonNullObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return asCanonicalLeaf(value);
}

/** Stable JSON encoding for fingerprints and idempotency comparisons. */
export function canonicalJson<T>(value: T): string {
  return JSON.stringify(canonicalize(value));
}
