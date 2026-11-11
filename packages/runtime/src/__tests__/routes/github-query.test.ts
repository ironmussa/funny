/**
 * Query helpers for the GitHub routes (`routes/github/query.ts`). Their values
 * are interpolated into GitHub API URLs, so `state` and `sort` must be one of
 * the values GitHub accepts, and numbers must be positive integers.
 */
import type { DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import type { Result } from 'neverthrow';
import { describe, test, expect } from 'vitest';

import {
  positiveIntParam,
  prCommentKindParam,
  readIssueState,
  readPaging,
  readRepoSort,
} from '../../routes/github/query.js';

function unwrap<T>(result: Result<T, DomainError>): T {
  return result.match(
    (value) => value,
    (error) => {
      throw new Error(`expected Ok, got: ${error.message}`);
    },
  );
}

/** Run `read` against a request with `query` and return what it produced. */
async function withQuery<T>(query: string, read: (c: Context) => T): Promise<T> {
  let value!: T;
  const app = new Hono();
  app.get('/', (c) => {
    value = read(c);
    return c.text('ok');
  });
  await app.request(`/?${query}`);
  return value;
}

describe('readPaging', () => {
  test('defaults when absent', async () => {
    expect(await withQuery('', (c) => readPaging(c, 30))).toEqual({ page: 1, perPage: 30 });
  });

  test('keeps valid values and clamps per_page to 100', async () => {
    expect(await withQuery('page=3&per_page=500', (c) => readPaging(c, 30))).toEqual({
      page: 3,
      perPage: 100,
    });
  });

  test('falls back for unparsable, fractional or non-positive values', async () => {
    expect(await withQuery('page=abc&per_page=-5', (c) => readPaging(c, 30))).toEqual({
      page: 1,
      perPage: 30,
    });
    expect(await withQuery('page=1.5&per_page=0', (c) => readPaging(c, 100))).toEqual({
      page: 1,
      perPage: 100,
    });
  });
});

describe('readIssueState', () => {
  test('defaults to open and accepts the three states', async () => {
    expect(unwrap(await withQuery('', readIssueState))).toBe('open');
    expect(unwrap(await withQuery('state=all', readIssueState))).toBe('all');
  });

  test('refuses a value that would add parameters to the GitHub URL', async () => {
    const result = await withQuery('state=open%26per_page%3D1', readIssueState);
    expect(result.isErr()).toBe(true);
  });
});

describe('readRepoSort', () => {
  test('defaults to updated and refuses unknown orders', async () => {
    expect(unwrap(await withQuery('', readRepoSort))).toBe('updated');
    expect((await withQuery('sort=updated%26q%3Dx', readRepoSort)).isErr()).toBe(true);
  });
});

describe('positiveIntParam', () => {
  test('returns the number, or 0 when missing or not a positive integer', async () => {
    const read = (c: Context) => positiveIntParam(c, 'prNumber');
    expect(await withQuery('prNumber=42', read)).toBe(42);
    expect(await withQuery('', read)).toBe(0);
    expect(await withQuery('prNumber=1.5', read)).toBe(0);
    expect(await withQuery('prNumber=-2', read)).toBe(0);
    expect(await withQuery('prNumber=abc', read)).toBe(0);
  });
});

describe('prCommentKindParam', () => {
  test('returns the kind only when it is issue or review', async () => {
    expect(await withQuery('kind=review', prCommentKindParam)).toBe('review');
    expect(await withQuery('kind=pull', prCommentKindParam)).toBeUndefined();
  });
});
