/** Decoders for gRPC wire values that may arrive as JSON-safe strings. */
import { isString } from '../lib/value-guards.js';

export function binary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (!isString(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

export function unsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}
