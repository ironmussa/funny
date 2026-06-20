import { z, type ZodTypeAny } from 'zod';

export interface JsonValidationIssue {
  path: string;
  message: string;
}

export type JsonValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; issues: JsonValidationIssue[] };

function formatIssues(error: z.ZodError): JsonValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message,
  }));
}

function validatePayload<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  label: string,
): JsonValidationResult<z.infer<TSchema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = formatIssues(parsed.error);
  const first = issues[0];
  return {
    ok: false,
    error: first ? `${label}: ${first.path}: ${first.message}` : `${label}: invalid JSON shape`,
    issues,
  };
}

export function parseStoredJson<TSchema extends ZodTypeAny>(
  schema: TSchema,
  raw: string,
  label = 'stored JSON',
): JsonValidationResult<z.infer<TSchema>> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `${label}: invalid JSON${err instanceof Error ? `: ${err.message}` : ''}`,
      issues: [],
    };
  }
  return validatePayload(schema, value, label);
}

export function parseExternalPayload<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  source = 'external payload',
): JsonValidationResult<z.infer<TSchema>> {
  return validatePayload(schema, value, source);
}
