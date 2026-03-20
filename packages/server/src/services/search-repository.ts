/**
 * Thread content search backed by the server's database.
 * Supports FTS5 (SQLite), tsvector (PostgreSQL), and LIKE fallback.
 */

import { eq, and, like } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db, dbAll, schema } from '../db/index.js';

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

  try {
    return searchViaFts5(query, projectId, userId);
  } catch {
    return await searchViaLike(query, projectId, userId);
  }
}

function searchViaFts5(
  query: string,
  projectId: string | undefined,
  userId: string,
): Map<string, string> {
  const ftsQuery = escapeFts5Query(query);

  let stmt = sql`
    SELECT m.thread_id AS threadId, snippet(messages_fts, 0, '', '', '…', 30) AS snippet
    FROM messages_fts AS fts
    JOIN messages AS m ON m.rowid = fts.rowid
    JOIN threads AS t ON t.id = m.thread_id
    WHERE fts.content MATCH ${ftsQuery}
  `;

  if (userId !== '__local__') {
    stmt = sql`${stmt} AND t.user_id = ${userId}`;
  }
  if (projectId) {
    stmt = sql`${stmt} AND t.project_id = ${projectId}`;
  }

  stmt = sql`${stmt} GROUP BY m.thread_id`;

  const rows = db.all<{ threadId: string; snippet: string }>(stmt);
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.threadId, row.snippet.replace(/\n/g, ' '));
  }
  return result;
}

async function searchViaLike(
  query: string,
  projectId: string | undefined,
  userId: string,
): Promise<Map<string, string>> {
  const safeQuery = escapeLike(query.trim());

  const filters: ReturnType<typeof eq>[] = [like(schema.messages.content, `%${safeQuery}%`)];

  if (userId !== '__local__') {
    filters.push(eq(schema.threads.userId, userId));
  }
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
