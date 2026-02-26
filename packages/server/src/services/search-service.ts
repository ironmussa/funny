/**
 * Thread content search (FTS5 + LIKE fallback).
 * Extracted from thread-manager.ts for single-responsibility.
 */

import { eq, and, like } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

/** Escape SQL LIKE wildcards so user input is treated as literal text */
function escapeLike(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Escape FTS5 special characters so user input is treated as literal text.
 *  Wraps each term in double quotes to prevent FTS5 query syntax injection. */
function escapeFts5Query(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Search for thread IDs whose messages contain the given query string.
 *  Uses FTS5 full-text index for fast search. Falls back to LIKE if FTS fails.
 *  Returns a Map of threadId → snippet for matching threads. */
export function searchThreadIdsByContent(opts: {
  query: string;
  projectId?: string;
  userId: string;
}): Map<string, string> {
  const { query, projectId, userId } = opts;
  if (!query.trim()) return new Map();

  try {
    return searchViaFts5(query, projectId, userId);
  } catch {
    return searchViaLike(query, projectId, userId);
  }
}

/** Fast path: FTS5 search with snippet() for highlighted context. */
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

/** Slow fallback: LIKE-based search (used if FTS table doesn't exist yet) */
function searchViaLike(
  query: string,
  projectId: string | undefined,
  userId: string,
): Map<string, string> {
  const safeQuery = escapeLike(query.trim());

  const filters: ReturnType<typeof eq>[] = [like(schema.messages.content, `%${safeQuery}%`)];

  if (userId !== '__local__') {
    filters.push(eq(schema.threads.userId, userId));
  }
  if (projectId) {
    filters.push(eq(schema.threads.projectId, projectId));
  }

  const rows = db
    .select({ threadId: schema.messages.threadId, content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
    .where(and(...filters))
    .all();

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
