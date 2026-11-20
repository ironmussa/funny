import { expect } from 'bun:test';

import { z } from 'zod';

/** Asserts `value` is an instance of `type` and returns it narrowed. */
export function expectInstance<V, T>(value: V, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  if (!(value instanceof type)) throw new Error(`expected an instance of ${type.name}`);
  return value;
}

const exitStatusSchema = z.object({ status: z.number() });

/** The numeric exit `status` an `execFileSync` failure carries, if any. */
export function exitStatusOf<E>(error: E): number | undefined {
  const parsed = exitStatusSchema.safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

/**
 * A `fetch` double: the handler answers every request, and `preconnect` (which
 * Bun's `fetch` type also carries) does nothing.
 */
export function fetchDouble(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}
