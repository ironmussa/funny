import { badRequest, validationErr, type DomainError } from '@funny/shared/errors';
import type { Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';
import { z, type ZodTypeAny } from 'zod';

import { isString } from '../lib/value-guards.js';
import type { HonoEnv } from '../types/hono-env.js';
import { validate } from './schemas.js';

/** Parse and validate a Hono JSON request body at the route boundary. */
export async function parseJsonBody<TSchema extends ZodTypeAny>(
  c: Context,
  schema: TSchema,
): Promise<Result<z.infer<TSchema>, DomainError>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(validationErr('Invalid JSON request body'));
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return err(validationErr(firstIssue?.message ?? 'Invalid request body'));
  }
  return ok(parsed.data);
}

/** The request's JSON body validated against `schema`; a missing or malformed body reads as `{}`. */
export async function readBody<Body>(
  c: Context<HonoEnv>,
  schema: z.ZodType<Body> | undefined,
): Promise<Result<Body, DomainError>> {
  if (!schema) {
    // SAFETY: a route without a body schema declares Body = undefined (the default).
    return ok(undefined as Body);
  }
  return validate(schema, await c.req.json().catch(() => ({})));
}

/** The required `?path=` query parameter. */
export function requirePathQuery(c: Context): Result<string, DomainError> {
  const path = c.req.query('path');
  return path ? ok(path) : err(badRequest('Missing required query parameter: path'));
}

/** Parse and validate Hono query parameters at the route boundary. */
export function parseQuery<TSchema extends ZodTypeAny>(
  c: Context,
  schema: TSchema,
): Result<z.infer<TSchema>, DomainError> {
  const parsed = schema.safeParse(queryValues(c));
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return err(validationErr(firstIssue?.message ?? 'Invalid query parameters'));
  }
  return ok(parsed.data);
}

/** Boolean query coercion that treats "false" as false, unlike z.coerce.boolean(). */
export const queryBoolean = z.preprocess((value) => {
  if (!isString(value)) return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}, z.boolean());

/** Query list coercion supporting repeated params and comma-separated values. */
export function queryList<TSchema extends ZodTypeAny>(itemSchema: TSchema) {
  return z.preprocess((value) => {
    const values = Array.isArray(value) ? value : isString(value) ? [value] : value;
    if (!Array.isArray(values)) return values;
    return values
      .flatMap((item: string) => item.split(',').map((part: string) => part.trim()))
      .filter(Boolean);
  }, z.array(itemSchema));
}

/** A request's query parameters: one value, or every value of a repeated key. */
interface QueryValues {
  [key: string]: string | string[];
}

function queryValues(c: Context): QueryValues {
  const values: QueryValues = { ...c.req.query() };
  for (const [key, allValues] of Object.entries(c.req.queries())) {
    if (allValues.length > 1) values[key] = allValues;
    else if (allValues[0] !== undefined) values[key] = allValues[0];
  }
  return values;
}
