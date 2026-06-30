/**
 * YAML pipeline parser.
 *
 * Reads a YAML string, validates it against `workflowSchema`, and returns
 * either a typed `ParsedWorkflow` (success) or a structured error.
 *
 * No I/O here — file reading is the caller's responsibility. This keeps
 * the parser unit-testable without disk fixtures.
 */

import { parse as parseYaml, YAMLParseError } from 'yaml';

import { workflowSchema, type ParsedWorkflow } from './schema.js';

export interface ParseError {
  /** One-line summary suitable for logs / UI. */
  message: string;
  /**
   * Detailed issues — populated when the YAML parses but fails the schema.
   * Empty when the YAML itself is malformed.
   */
  issues: Array<{ path: string; message: string }>;
}

export type ParseResult = { ok: true; workflow: ParsedWorkflow } | { ok: false; error: ParseError };

/**
 * Parse a YAML workflow definition.
 *
 * @param source - Raw YAML text.
 * @param origin - Optional label (e.g. file path) used in error messages.
 */
export function parseWorkflowYaml(source: string, origin = '<inline>'): ParseResult {
  // 1. YAML → JS object.
  let raw: unknown;
  try {
    raw = parseYaml(source, { strict: true, prettyErrors: true });
  } catch (err) {
    if (err instanceof YAMLParseError) {
      return {
        ok: false,
        error: {
          message: `Invalid YAML in ${origin}: ${err.message}`,
          issues: [],
        },
      };
    }
    return {
      ok: false,
      error: {
        message: `Failed to parse ${origin}: ${err instanceof Error ? err.message : String(err)}`,
        issues: [],
      },
    };
  }

  if (raw === null || raw === undefined) {
    return {
      ok: false,
      error: { message: `${origin} is empty`, issues: [] },
    };
  }

  // 2. Object → ParsedWorkflow.
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: `Invalid workflow definition in ${origin}`,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }

  return { ok: true, workflow: parsed.data };
}

/**
 * Format a parse error for display. Returns a multi-line string suitable
 * for logging or showing to the user.
 */
export function formatParseError(error: ParseError): string {
  if (error.issues.length === 0) return error.message;
  const detail = error.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
  return `${error.message}\n${detail}`;
}
