/**
 * Thread content search backed by the server's database.
 * Supports FTS5 (SQLite), tsvector (PostgreSQL), and LIKE fallback.
 */

import { eq, and, like } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db, dbAll, dbDialect, schema } from '../db/index.js';

function escapeLike(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
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
}): Promise<Map<string, string>> {
  const { query, projectId, userId } = opts;
  if (!query.trim()) return new Map();

  // When the query contains characters that FTS tokenizers strip (e.g. _TOKEN),
  // go straight to LIKE which does exact substring matching.
  if (needsLikeFallback(query)) {
    return await searchViaLike(query, projectId, userId);
  }

  // Dialect-specific full-text search with LIKE fallback on error
  try {
    if (dbDialect === 'pg') {
      return await searchViaTsvector(query, projectId, userId);
    }
    return await searchViaFts5(query, projectId, userId);
  } catch {
    return await searchViaLike(query, projectId, userId);
  }
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
): Promise<Map<string, string>> {
  const safeQuery = escapeLike(query.trim());

  const filters: ReturnType<typeof eq>[] = [like(schema.messages.content, `%${safeQuery}%`)];

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
  const queryLower = query.trim().toLowerCase();
  for (const row of rows) {
    if (result.has(row.threadId)) continue;
    const idx = row.content.toLowerCase().indexOf(queryLower);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 30);
    const end = Math.min(row.content.length, idx + queryLower.length + 50);
    let snippet = row.content.slice(start, end).replace(/\n/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < row.content.length) snippet = snippet + '…';
    result.set(row.threadId, snippet);
  }

  return result;
}
