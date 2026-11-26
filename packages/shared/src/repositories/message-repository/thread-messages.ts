/** `getThreadMessages`: one page of a thread's messages before or after a cursor. */

import { eq, and, gt, lt, asc, desc } from 'drizzle-orm';

import type { RepoDeps } from '../deps.js';
import {
  countMessagesBefore,
  countThreadMessages,
  enrichMessages,
  findLeadingUserMessage,
  type EnrichedMessage,
} from './rows.js';

/** Get paginated messages for a thread, older than cursor.
 *  Returns messages in ASC order (oldest first).
 *  `total` is the full message count so the client can describe the loaded
 *  window within the complete history. */
export async function getThreadMessages(
  deps: RepoDeps,
  opts: {
    threadId: string;
    cursor?: string;
    limit: number;
    direction?: 'before' | 'after';
  },
): Promise<{
  messages: EnrichedMessage[];
  hasMore: boolean;
  hasMoreAfter: boolean;
  total: number;
  windowStart: number;
  leadingUserMessage?: EnrichedMessage;
}> {
  const { db, schema, dbAll } = deps;
  const { threadId, cursor, limit, direction = 'before' } = opts;

  const [rows, total] = await Promise.all([
    dbAll(
      db
        .select()
        .from(schema.messages)
        .where(
          cursor
            ? and(
                eq(schema.messages.threadId, threadId),
                direction === 'after'
                  ? gt(schema.messages.timestamp, cursor)
                  : lt(schema.messages.timestamp, cursor),
              )
            : eq(schema.messages.threadId, threadId),
        )
        .orderBy(
          direction === 'after' ? asc(schema.messages.timestamp) : desc(schema.messages.timestamp),
        )
        .limit(limit + 1),
    ),
    countThreadMessages(deps, threadId),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const sliced = direction === 'after' ? page : page.reverse();
  const windowStart =
    sliced.length > 0 ? await countMessagesBefore(deps, threadId, sliced[0].timestamp) : 0;
  const leadingUserMessage =
    sliced.length > 0 && sliced[0].role !== 'user'
      ? await findLeadingUserMessage(deps, threadId, sliced[0])
      : undefined;

  return {
    messages: await enrichMessages(deps, sliced),
    hasMore: direction === 'after' || cursor ? windowStart > 0 : hasMore,
    hasMoreAfter: direction === 'after' ? hasMore : windowStart + sliced.length < total,
    total,
    windowStart,
    leadingUserMessage: leadingUserMessage
      ? (await enrichMessages(deps, [leadingUserMessage]))[0]
      : undefined,
  };
}
