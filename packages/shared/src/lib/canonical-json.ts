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
type CanonicalValue = CanonicalLeaf | CanonicalValue[] | { [key: string]: CanonicalValue };

/** How a canonical copy orders object keys. */
export type CanonicalKeyOrder = (left: string, right: string) => number;

/** The value as a leaf, once it is known to be neither an array nor a non-null object. */
function asCanonicalLeaf<T>(value: T): CanonicalLeaf {
  // SAFETY: only `canonicalize` calls this, after both the Array.isArray and the non-null
  // object check failed, so `value` is a primitive, null, undefined or a function.
  return value as CanonicalLeaf;
}

function canonicalize<T>(value: T, order: CanonicalKeyOrder): CanonicalValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, order));
  if (isNonNullObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => order(left, right))
        .map(([key, entry]) => [key, canonicalize(entry, order)]),
    );
  }
  return asCanonicalLeaf(value);
}

/** JSON with every object's keys sorted by `order`, at every depth. */
export function canonicalJsonWithKeyOrder<T>(value: T, order: CanonicalKeyOrder): string {
  return JSON.stringify(canonicalize(value, order));
}

/** Stable JSON encoding for fingerprints and idempotency comparisons. */
export function canonicalJson<T>(value: T): string {
  return canonicalJsonWithKeyOrder(value, (left, right) => left.localeCompare(right));
}
