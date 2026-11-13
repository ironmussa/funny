/**
 * Thread content search backed by the server's database.
 * Supports FTS5 (SQLite), tsvector (PostgreSQL), and LIKE fallback.
 */

import {
  findTextSearchMatches,
  includesSearchText,
  normalizeSearchText,
} from '@funny/shared/lib/text-search';
import { eq, and, desc } from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';

import { db, dbAll, dbDialect, schema } from '../db/index.js';

function escapeLike(value: string): string {
  // Escape the LIKE wildcards (`%`, `_`) and the escape char itself. Must be
  // paired with an `ESCAPE '\'` clause on the LIKE, otherwise the backslash is
  // taken literally and `apply_patch` would never match.
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const isAsciiChar = (ch: string) => ch.charCodeAt(0) < 0x80;
const hasAscii = (text: string) => Array.from(text).some(isAsciiChar);
const isAscii = (text: string) => Array.from(text).every(isAsciiChar);

/**
 * Bracket-class body (no brackets) of every non-ASCII character that
 * `normalizeSearchText` folds onto ASCII or erases: precomposed letters
 * (`ñ` → `n`), `≠` → `=`, and every combining mark (`\p{M}`), which is
 * stripped and so can sit inside an ASCII word. Derived from the folding
 * itself so it cannot drift from it; built once, on the first search (~150 ms).
 */
let foldsToAsciiClass: string | undefined;
function foldsToAscii(): string {
  if (foldsToAsciiClass !== undefined) return foldsToAsciiClass;
  const ranges: [number, number][] = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogates are not characters
    const folded = normalizeSearchText(String.fromCodePoint(cp));
    if (folded !== '' && !hasAscii(folded)) continue;
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  foldsToAsciiClass = ranges
    .map(([from, to]) =>
      from === to
        ? String.fromCodePoint(from)
        : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
    )
    .join('');
  return foldsToAsciiClass;
}

/** `content` holds at least one character of the bracket class `[body]`. */
function contentHasCharIn(body: string): SQL {
  const content = schema.messages.content;
  return dbDialect === 'pg'
    ? sql`${content} ~ ${`[${body}]`}`
    : sql`${content} glob ${`*[${body}]*`}`;
}

/**
 * SQL pre-filter for a case- and diacritic-insensitive content search
 * (issue #191). SQL has no portable Unicode-folding collation, so the exact
 * comparison stays in JS (`includesSearchText`); this narrows the rows to a
 * superset of the matches so the database, not the server, discards the rest.
 *
 * - The folded query is ASCII (the common case, including `niña` → `nina`):
 *   in a message without any character of {@link foldsToAscii}, folding
 *   only lowercases the ASCII runs, so `lower(content) LIKE` decides; a
 *   message with such a character is left to the JS check.
 * - Otherwise a match needs at least one non-ASCII character. (NUL is
 *   excluded from the class because SQL text parameters cannot carry it.)
 */
export function contentPrefilter(query: string): SQL {
  const folded = normalizeSearchText(query.trim());
  if (!folded) return sql`1 = 1`;
  if (!isAscii(folded)) return contentHasCharIn('^\u0001-\u007F');
  const pattern = `%${escapeLike(folded)}%`;
  return sql`(lower(${schema.messages.content}) like ${pattern} escape '\\' or ${contentHasCharIn(foldsToAscii())})`;
}

/** Content filter for either search mode; a superset of the JS-checked matches. */
function contentFilter(query: string, caseSensitive: boolean): SQL {
  return caseSensitive
    ? sql`${schema.messages.content} like ${`%${escapeLike(query)}%`} escape '\\'`
    : contentPrefilter(query);
}

/** Rows fetched per round trip by the JS-filtered scans below. */
const SCAN_PAGE_SIZE = 500;

interface MessageCursor {
  timestamp: string;
  id: string;
}

/**
 * Reads messages in pages of {@link SCAN_PAGE_SIZE}, ordered by
 * `(timestamp, id)`, so the JS filter can stop early and memory stays bounded.
 * Keyset paging (not OFFSET): a message inserted mid-scan never shifts a page,
 * so no row is read twice or skipped, and each page costs the same.
 * `page(after)` must return rows after the cursor in the given `order`.
 */
async function* scanMessages<T extends MessageCursor>(
  page: (after: SQL | undefined) => Promise<T[]>,
  order: 'asc' | 'desc',
): AsyncGenerator<T> {
  const { timestamp, id } = schema.messages;
  let after: SQL | undefined;
  while (true) {
    const rows = await page(after);
    yield* rows;
    if (rows.length < SCAN_PAGE_SIZE) return;
    const last = rows[rows.length - 1]!;
    after =
      order === 'desc'
        ? sql`(${timestamp} < ${last.timestamp} or (${timestamp} = ${last.timestamp} and ${id} < ${last.id}))`
        : sql`(${timestamp} > ${last.timestamp} or (${timestamp} = ${last.timestamp} and ${id} > ${last.id}))`;
  }
}

function escapeFts5Query(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Returns true when the query contains characters (like `_`) that FTS
 * tokenizers typically strip, making full-text search unreliable.
 * In those cases we should use LIKE instead.
 */
function needsLikeFallback(query: string): boolean {
  // FTS tokenizers (unicode61 / english) keep only alphanumeric chars.
  // If the query contains connectors or punctuation that are meaningful
  // to the user (e.g. _TOKEN, .env, @scope) FTS won't match reliably.
  return /[_@.#$%^&*+!=<>{}[\]\\|/~`]/.test(query);
}

export async function searchThreadIdsByContent(opts: {
  query: string;
  projectId?: string;
  userId: string;
  caseSensitive?: boolean;
}): Promise<Map<string, string>> {
  const { query, projectId, userId, caseSensitive = false } = opts;
  if (!query.trim()) return new Map();

  // FTS5 / tsvector are inherently case-insensitive (tokens are lowercased).
  // For case-sensitive search, always use the LIKE path which does exact substring matching.
  if (caseSensitive || needsLikeFallback(query)) {
    return await searchViaLike(query, projectId, userId, caseSensitive);
  }

  // Use the index for a fast first pass, then merge a normalized substring
  // search. FTS tokenizers do not fold all diacritics consistently, so the
  // normalized pass is needed for results such as `nina` → `niña`.
  try {
    const indexedResults =
      dbDialect === 'pg'
        ? await searchViaTsvector(query, projectId, userId)
        : await searchViaFts5(query, projectId, userId);
    const normalizedResults = await searchViaLike(query, projectId, userId, false);
    return new Map([...indexedResults, ...normalizedResults]);
  } catch {
    return await searchViaLike(query, projectId, userId, false);
  }
}

/** One matching message returned by {@link searchThreadMessages}. */
export interface ThreadMessageMatch {
  threadId: string;
  threadTitle: string;
  messageId: string;
  role: string;
  author: string | null;
  timestamp: string;
  snippet: string;
}

/**
 * Search a user's messages across ALL their threads, combining any of:
 *   - free-text substring (`query`, in message content)
 *   - `author` substring (matched against `messages.author`)
 *   - a time window (`since` / `until`, ISO-8601 timestamps; inclusive)
 *
 * Always scoped to `userId` (the runner's authenticated owner) — never trust a
 * caller-supplied id. Returns at most `limit` matches, most-recent first.
 *
 * Unlike {@link searchThreadIdsByContent} (one snippet PER thread, for the UI
 * search panel) this returns one row PER matching message, which is what the
 * `funny_search_threads` agent tool surfaces. LIKE-based so the text/author/
 * time filters compose in a single dialect-agnostic query (FTS5/tsvector can't
 * be combined with the structured filters cleanly).
 *
 * At least one positive filter (query/author/since/until) is required; with
 * only the user scope it returns [] rather than the user's entire history.
 */
export async function searchThreadMessages(opts: {
  userId: string;
  query?: string;
  author?: string;
  since?: string;
  until?: string;
  projectId?: string;
  limit?: number;
  caseSensitive?: boolean;
}): Promise<ThreadMessageMatch[]> {
  const { userId, projectId, since, until, limit = 50, caseSensitive = false } = opts;
  const query = opts.query?.trim() ?? '';
  const author = opts.author?.trim() ?? '';

  if (!userId) return [];
  if (!query && !author && !since && !until) return [];

  const filters: SQL[] = [eq(schema.threads.userId, userId)];
  if (projectId) filters.push(eq(schema.threads.projectId, projectId));
  if (query) filters.push(contentFilter(query, caseSensitive));
  if (author) {
    filters.push(sql`${schema.messages.author} like ${`%${escapeLike(author)}%`} escape '\\'`);
  }
  if (since) filters.push(sql`${schema.messages.timestamp} >= ${since}`);
  if (until) filters.push(sql`${schema.messages.timestamp} <= ${until}`);

  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 50));

  // The SQL filters are a superset of the matches (the exact Unicode-aware
  // comparison happens below), so read newest first in pages and stop at the cap.
  const rows = scanMessages(
    (after) =>
      dbAll(
        db
          .select({
            threadId: schema.messages.threadId,
            threadTitle: schema.threads.title,
            id: schema.messages.id,
            role: schema.messages.role,
            author: schema.messages.author,
            timestamp: schema.messages.timestamp,
            content: schema.messages.content,
          })
          .from(schema.messages)
          .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
          .where(and(...filters, after))
          .orderBy(desc(schema.messages.timestamp), desc(schema.messages.id))
          .limit(SCAN_PAGE_SIZE),
      ),
    'desc',
  );

  const results: ThreadMessageMatch[] = [];
  for await (const row of rows) {
    let snippet: string;
    if (query) {
      if (!includesSearchText(row.content, query, caseSensitive)) continue;
      const match = findTextSearchMatches(row.content, query, caseSensitive)[0]!;
      const start = Math.max(0, match.start - 30);
      const end = Math.min(row.content.length, match.end + 50);
      snippet = row.content.slice(start, end).replace(/\n/g, ' ');
      if (start > 0) snippet = '…' + snippet;
      if (end < row.content.length) snippet = snippet + '…';
    } else {
      snippet = row.content.slice(0, 80).replace(/\n/g, ' ');
      if (row.content.length > 80) snippet += '…';
    }
    results.push({
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      messageId: row.id,
      role: row.role,
      author: row.author,
      timestamp: row.timestamp,
      snippet,
    });
    if (results.length >= cap) break;
  }
  return results;
}

// ── SQLite FTS5 ──────────────────────────────────────────────────

async function searchViaFts5(
  query: string,
  projectId: string | undefined,
  userId: string,
): Promise<Map<string, string>> {
  const ftsQuery = escapeFts5Query(query);

  let stmt = sql`
    SELECT m.thread_id AS threadId, snippet(messages_fts, 0, '', '', '…', 30) AS snippet
    FROM messages_fts AS fts
    JOIN messages AS m ON m.rowid = fts.rowid
    JOIN threads AS t ON t.id = m.thread_id
    WHERE fts.content MATCH ${ftsQuery}
  `;

  stmt = sql`${stmt} AND t.user_id = ${userId}`;
  if (projectId) {
    stmt = sql`${stmt} AND t.project_id = ${projectId}`;
  }

  stmt = sql`${stmt} GROUP BY m.thread_id`;

  // SQLite: synchronous .all() on raw SQL is the correct API for FTS5 queries.
  // This is intentionally dialect-specific — guarded by the dbDialect check above.
  const rows = (db as any).all(stmt) as {
    threadId: string;
    snippet: string;
  }[];

  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.threadId, row.snippet.replace(/\n/g, ' '));
  }
  return result;
}

// ── PostgreSQL tsvector ──────────────────────────────────────────

async function searchViaTsvector(
  query: string,
  projectId: string | undefined,
  userId: string,
): Promise<Map<string, string>> {
  // Build a tsquery from the user input — each word becomes a lexeme joined with &
  const tsQuery = query
    .trim()
    .split(/\s+/)
    .map((t) => `'${t.replace(/'/g, "''")}'`)
    .join(' & ');

  let stmt = sql`
    SELECT m.thread_id AS "threadId",
           ts_headline('english', m.content, to_tsquery('english', ${tsQuery}),
                       'MaxFragments=1, MaxWords=30, MinWords=10') AS snippet
    FROM messages AS m
    JOIN threads AS t ON t.id = m.thread_id
    WHERE m.search_vector @@ to_tsquery('english', ${tsQuery})
  `;

  stmt = sql`${stmt} AND t.user_id = ${userId}`;
  if (projectId) {
    stmt = sql`${stmt} AND t.project_id = ${projectId}`;
  }

  stmt = sql`${stmt} GROUP BY m.thread_id, m.content, m.search_vector`;

  // PostgreSQL: async execute
  const rows = await dbAll<{ threadId: string; snippet: string }>((db as any).execute(stmt));

  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.threadId, row.snippet.replace(/\n/g, ' '));
  }
  return result;
}

// ── LIKE fallback (dialect-agnostic) ─────────────────────────────

async function searchViaLike(
  query: string,
  projectId: string | undefined,
  userId: string,
  caseSensitive: boolean,
): Promise<Map<string, string>> {
  const trimmed = query.trim();

  const filters: SQL[] = [contentFilter(trimmed, caseSensitive), eq(schema.threads.userId, userId)];
  if (projectId) {
    filters.push(eq(schema.threads.projectId, projectId));
  }

  // Oldest first, so each thread's snippet comes from its earliest match.
  const rows = scanMessages(
    (after) =>
      dbAll(
        db
          .select({
            threadId: schema.messages.threadId,
            id: schema.messages.id,
            timestamp: schema.messages.timestamp,
            content: schema.messages.content,
          })
          .from(schema.messages)
          .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
          .where(and(...filters, after))
          .orderBy(schema.messages.timestamp, schema.messages.id)
          .limit(SCAN_PAGE_SIZE),
      ),
    'asc',
  );

  const result = new Map<string, string>();
  for await (const row of rows) {
    if (result.has(row.threadId)) continue;
    if (!includesSearchText(row.content, trimmed, caseSensitive)) continue;
    const match = findTextSearchMatches(row.content, trimmed, caseSensitive)[0]!;
    const start = Math.max(0, match.start - 30);
    const end = Math.min(row.content.length, match.end + 50);
    let snippet = row.content.slice(start, end).replace(/\n/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < row.content.length) snippet = snippet + '…';
    result.set(row.threadId, snippet);
  }

  return result;
}
