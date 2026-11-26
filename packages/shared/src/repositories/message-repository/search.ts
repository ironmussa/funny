/** `searchMessages`: content search within one thread, with a snippet per match. */

import { eq, and, asc, sql } from 'drizzle-orm';

import { findTextSearchMatches, includesSearchText } from '../../lib/text-search.js';
import type { RepoDeps } from '../deps.js';

/** The text around a match: 40 characters before, 60 after, on one line. */
function snippetAround(content: string, match: { start: number; end: number }): string {
  const start = Math.max(0, match.start - 40);
  const end = Math.min(content.length, match.end + 60);
  let snippet = content.slice(start, end).replace(/\n/g, ' ');
  if (start > 0) snippet = '…' + snippet;
  if (end < content.length) snippet = snippet + '…';
  return snippet;
}

/** Search messages within a thread by content substring.
 *  Returns matching message IDs, roles, timestamps and a snippet. */
export async function searchMessages(
  deps: RepoDeps,
  opts: {
    threadId: string;
    query: string;
    limit?: number;
    caseSensitive?: boolean;
  },
): Promise<
  {
    messageId: string;
    role: string;
    content: string;
    timestamp: string;
    snippet: string;
  }[]
> {
  const { db, schema, dbAll } = deps;
  const { threadId, query, limit = 100, caseSensitive = false } = opts;
  // Escape the LIKE wildcards (`%`, `_`) AND the escape char itself so a query
  // like `apply_patch` matches a literal underscore instead of "any char".
  // The matching `ESCAPE '\'` clause is REQUIRED — without it the backslash is
  // treated as a literal, so `apply\_patch` would never match `apply_patch`.
  const safeQuery = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  // SQL has no portable Unicode-diacritic-insensitive collation. Use the
  // literal pre-filter only for a case-sensitive search; the default search
  // must inspect all messages in the thread before applying shared folding.
  const rows = await dbAll(
    db
      .select({
        id: schema.messages.id,
        role: schema.messages.role,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          ...(caseSensitive
            ? [sql`${schema.messages.content} like ${`%${safeQuery}%`} escape '\\'`]
            : []),
        ),
      )
      .orderBy(asc(schema.messages.timestamp)),
  );

  const results: {
    messageId: string;
    role: string;
    content: string;
    timestamp: string;
    snippet: string;
  }[] = [];
  for (const row of rows) {
    if (!includesSearchText(row.content, query, caseSensitive)) continue;
    const match = findTextSearchMatches(row.content, query, caseSensitive)[0]!;
    results.push({
      messageId: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      snippet: snippetAround(row.content, match),
    });
    if (results.length >= limit) break;
  }
  return results;
}
