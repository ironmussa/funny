import { validationErr, type DomainError } from '@funny/shared/errors';
import type { Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';
import { z, type ZodTypeAny } from 'zod';

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
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}, z.boolean());

/** Query list coercion supporting repeated params and comma-separated values. */
export function queryList<TSchema extends ZodTypeAny>(itemSchema: TSchema) {
  return z.preprocess((value) => {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values)) return values;
    return values
      .flatMap((item: string) => item.split(',').map((part: string) => part.trim()))
      .filter(Boolean);
  }, z.array(itemSchema));
}

function queryValues(c: Context): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = { ...c.req.query() };
  for (const [key, allValues] of Object.entries(c.req.queries())) {
    if (allValues.length > 1) values[key] = allValues;
    else if (allValues[0] !== undefined) values[key] = allValues[0];
  }
  return values;
}
