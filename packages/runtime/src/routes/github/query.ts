/**
 * Query parameters shared by the GitHub routes.
 *
 * These values end up in GitHub API URLs, so anything interpolated into a path
 * or query string (`state`, `sort`) is limited to the values GitHub accepts; a
 * free-form value such as `open&per_page=1` would otherwise add parameters to
 * the request. Paging keeps its old leniency: a missing or unparsable value
 * falls back to the default instead of being refused.
 */

import type { DomainError } from '@funny/shared/errors';
import type { Context } from 'hono';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import { parseQuery } from '../../validation/request.js';

/** A positive integer clamped to `max`; missing or unparsable gives `fallback`. */
const lenientPositiveInt = (fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  z
    .unknown()
    .optional()
    .transform((value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
    });

/** `page` and `per_page` (at most 100), with GitHub's names in the query. */
export function readPaging(c: Context, defaultPerPage: number): { page: number; perPage: number } {
  const schema = z.object({
    page: lenientPositiveInt(1),
    per_page: lenientPositiveInt(defaultPerPage, 100),
  });
  // Every field is lenient, so parsing cannot fail.
  const parsed = parseQuery(c, schema);
  return parsed.isOk()
    ? { page: parsed.value.page, perPage: parsed.value.per_page }
    : { page: 1, perPage: defaultPerPage };
}

const stateQuery = z.object({
  state: z
    .enum(['open', 'closed', 'all'], { error: 'state must be one of: open, closed, all' })
    .default('open'),
});

export function readIssueState(c: Context): Result<'open' | 'closed' | 'all', DomainError> {
  return parseQuery(c, stateQuery).map((q) => q.state);
}

const cursorQuery = z.object({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9+/=_-]{1,200}$/, { error: 'cursor is not a valid page cursor' })
    .optional(),
});

/** The opaque GraphQL page cursor a previous page returned, or `null` for page 1. */
export function readCursor(c: Context): Result<string | null, DomainError> {
  return parseQuery(c, cursorQuery).map((q) => q.cursor ?? null);
}

/** Sort orders `GET /user/repos` accepts; the repo search accepts `updated` too. */
const repoSortQuery = z.object({
  sort: z
    .enum(['created', 'updated', 'pushed', 'full_name'], {
      error: 'sort must be one of: created, updated, pushed, full_name',
    })
    .default('updated'),
});

export function readRepoSort(c: Context): Result<string, DomainError> {
  return parseQuery(c, repoSortQuery).map((q) => q.sort);
}

const positiveInt = z.coerce.number().int().positive();

/**
 * A PR or comment number: a positive integer, or `0` when it is missing or
 * invalid, so a caller's `if (!prNumber)` refuses it with its own message
 * (before, `Number('1.5')` or `Number('-2')` slipped through).
 */
export function positiveIntParam(c: Context, name: string): number {
  const parsed = parseQuery(c, z.object({ [name]: positiveInt }));
  return parsed.isOk() ? (parsed.value[name] as number) : 0;
}

/** `kind` of a PR comment, or `undefined` when missing or not one of the two kinds. */
export function prCommentKindParam(c: Context): 'issue' | 'review' | undefined {
  const parsed = parseQuery(c, z.object({ kind: z.enum(['issue', 'review']) }));
  return parsed.isOk() ? parsed.value.kind : undefined;
}
