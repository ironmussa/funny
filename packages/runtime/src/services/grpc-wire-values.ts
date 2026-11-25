import { isString } from '../lib/value-guards.js';
/** Decoders for gRPC wire values that may arrive as JSON-safe strings. */

/** A protobuf `bytes` field: raw bytes, or base64 in the JSON form. */
export type WireBytes = Uint8Array | string | null | undefined;

/** A protobuf `uint64` field: a bigint, a number, or a decimal string in the JSON form. */
export type WireUnsigned = bigint | number | string | null | undefined;

export function binary(value: WireBytes): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (!isString(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

export function unsigned(value: WireUnsigned): bigint | null {
  // BigInt(null) and BigInt(undefined) throw, as the catch below would answer.
  if (value === null || value === undefined) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}
