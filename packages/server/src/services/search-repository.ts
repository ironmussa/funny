/**
 * Thread content search backed by the server's database.
 * Supports FTS5 (SQLite), tsvector (PostgreSQL), and LIKE fallback.
 */

import { eq, and, desc } from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';

import { db, dbAll, dbDialect, schema } from '../db/index.js';

function escapeLike(value: string): string {
  // Escape the LIKE wildcards (`%`, `_`) and the escape char itself. Must be
  // paired with an `ESCAPE '\'` clause on the LIKE, otherwise the backslash is
  // taken literally and `apply_patch` would never match.
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

  // Dialect-specific full-text search with LIKE fallback on error
  try {
    if (dbDialect === 'pg') {
      return await searchViaTsvector(query, projectId, userId);
    }
    return await searchViaFts5(query, projectId, userId);
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
  if (query) {
    filters.push(sql`${schema.messages.content} like ${`%${escapeLike(query)}%`} escape '\\'`);
  }
  if (author) {
    filters.push(sql`${schema.messages.author} like ${`%${escapeLike(author)}%`} escape '\\'`);
  }
  if (since) filters.push(sql`${schema.messages.timestamp} >= ${since}`);
  if (until) filters.push(sql`${schema.messages.timestamp} <= ${until}`);

  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 50));

  // Over-fetch when we'll re-filter for case-sensitivity in JS (SQLite LIKE is
  // ASCII case-insensitive, so the SQL pass is only a coarse pre-filter there).
  const fetchLimit = query && caseSensitive ? cap * 4 : cap;

  const rows = await dbAll(
    db
      .select({
        threadId: schema.messages.threadId,
        threadTitle: schema.threads.title,
        messageId: schema.messages.id,
        role: schema.messages.role,
        author: schema.messages.author,
        timestamp: schema.messages.timestamp,
        content: schema.messages.content,
      })
      .from(schema.messages)
      .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
      .where(and(...filters))
      .orderBy(desc(schema.messages.timestamp))
      .limit(fetchLimit),
  );

  const needle = caseSensitive ? query : query.toLowerCase();
  const results: ThreadMessageMatch[] = [];
  for (const row of rows) {
    let snippet: string;
    if (query) {
      const haystack = caseSensitive ? row.content : row.content.toLowerCase();
      const idx = haystack.indexOf(needle);
      // caseSensitive: the coarse SQL LIKE may have matched a different case;
      // drop rows that don't contain the exact-case needle.
      if (caseSensitive && idx === -1) continue;
      const at = idx === -1 ? 0 : idx;
      const start = Math.max(0, at - 30);
      const end = Math.min(row.content.length, at + needle.length + 50);
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
      messageId: row.messageId,
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
  const rows = (db as any).all<{ threadId: string; snippet: string }>(stmt) as {
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
  const safeQuery = escapeLike(trimmed);

  // SQL `LIKE` semantics differ across drivers (SQLite ASCII-insensitive, PG case-sensitive).
  // We use it as a coarse filter and apply the exact case-sensitivity rule in JS below.
  const filters: SQL[] = [sql`${schema.messages.content} like ${`%${safeQuery}%`} escape '\\'`];

  filters.push(eq(schema.threads.userId, userId));
  if (projectId) {
    filters.push(eq(schema.threads.projectId, projectId));
  }

  const rows = await dbAll(
    db
      .select({ threadId: schema.messages.threadId, content: schema.messages.content })
      .from(schema.messages)
      .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
      .where(and(...filters)),
  );

  const result = new Map<string, string>();
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  for (const row of rows) {
    if (result.has(row.threadId)) continue;
    const haystack = caseSensitive ? row.content : row.content.toLowerCase();
    const idx = haystack.indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 30);
    const end = Math.min(row.content.length, idx + needle.length + 50);
    let snippet = row.content.slice(start, end).replace(/\n/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < row.content.length) snippet = snippet + '…';
    result.set(row.threadId, snippet);
  }

  return result;
}
