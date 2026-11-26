/**
 * `getThreadWithMessages`: a thread with the window of messages a client
 * opens it at, the prompts that frame that window, and its wait state.
 */

import { eq, and, asc, desc } from 'drizzle-orm';

import type { RepoDeps } from '../deps.js';
import {
  countMessagesBefore,
  countThreadMessages,
  enrichMessages,
  fetchToolCallsForMessages,
  findLeadingUserMessage,
  type MessageRow,
  type ToolCallRow,
} from './rows.js';
import { findPendingWaitState } from './wait-state.js';

type ThreadRow = RepoDeps['schema']['threads']['$inferSelect'];

/** Where a client last was in the thread: its scroll progress (0-1) or an anchor message / tool call. */
interface ThreadWindowOptions {
  messageProgress?: number;
  messageAnchorId?: string;
}

interface MessageWindow {
  messages: MessageRow[];
  hasMore: boolean;
  hasMoreAfter: boolean;
  windowStart: number;
  /** Full message count; only computed when paginating. */
  total: number | undefined;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** Timestamp of the message (or of the tool call's message) a client saved as its anchor. */
async function findAnchorTimestamp(deps: RepoDeps, threadId: string, anchorId: string) {
  const { db, schema, dbGet } = deps;
  const anchorMessage =
    (await dbGet(
      db
        .select({ timestamp: schema.messages.timestamp })
        .from(schema.messages)
        .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.id, anchorId)))
        .limit(1),
    )) ??
    (await dbGet(
      db
        .select({ timestamp: schema.messages.timestamp })
        .from(schema.toolCalls)
        .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
        .where(and(eq(schema.messages.threadId, threadId), eq(schema.toolCalls.id, anchorId)))
        .limit(1),
    ));
  return anchorMessage?.timestamp;
}

/** Index of the message the window centers on: the saved anchor, else the saved scroll progress. */
async function resolveTargetIndex(
  deps: RepoDeps,
  threadId: string,
  total: number,
  opts: ThreadWindowOptions,
): Promise<number> {
  const progress = isNumber(opts.messageProgress)
    ? Math.min(1, Math.max(0, opts.messageProgress))
    : 1;
  const anchorId =
    opts.messageAnchorId && !(isNumber(opts.messageProgress) && progress >= 0.999)
      ? opts.messageAnchorId
      : undefined;
  if (anchorId) {
    const anchorTimestamp = await findAnchorTimestamp(deps, threadId, anchorId);
    if (anchorTimestamp !== undefined) {
      return countMessagesBefore(deps, threadId, anchorTimestamp);
    }
  }
  return Math.round(Math.max(0, total - 1) * progress);
}

async function loadMessageWindow(
  deps: RepoDeps,
  threadId: string,
  messageLimit: number | undefined,
  opts: ThreadWindowOptions,
): Promise<MessageWindow> {
  const { db, schema, dbAll } = deps;
  if (!messageLimit) {
    const messages = await dbAll(
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.threadId, threadId))
        .orderBy(asc(schema.messages.timestamp)),
    );
    return { messages, hasMore: false, hasMoreAfter: false, windowStart: 0, total: undefined };
  }

  // Total message count for the thread. Paired with windowStart, this lets
  // clients understand where the loaded window sits within the full history.
  // Only needed when paginating (messageLimit set); a full load already knows
  // the total.
  const total = await countThreadMessages(deps, threadId);
  const maxStart = Math.max(0, total - messageLimit);
  const targetIndex = await resolveTargetIndex(deps, threadId, total, opts);
  const windowStart = Math.min(maxStart, Math.max(0, targetIndex - Math.floor(messageLimit / 2)));
  const messages = await dbAll(
    db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(asc(schema.messages.timestamp))
      .limit(messageLimit)
      .offset(windowStart),
  );
  return {
    messages,
    hasMore: windowStart > 0,
    hasMoreAfter: windowStart + messages.length < total,
    windowStart,
    total,
  };
}

/** The thread's latest user message, taken from the window when it can be. */
async function resolveLastUserMessage(
  deps: RepoDeps,
  threadId: string,
  window: MessageWindow,
): Promise<MessageRow | undefined> {
  const { db, schema, dbGet } = deps;
  const { messages } = window;

  // Most-recent user message in the loaded window (messages is ASC here).
  let lastUserMessage: MessageRow | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessage = messages[i];
      break;
    }
  }

  // A restored window can be in the middle of a long thread. In that case it
  // may contain an older user message while the actual latest prompt lives in
  // the unloaded newer history, so querying only when the window has no user
  // message violates the `lastUserMessage` contract.
  if (!lastUserMessage || window.hasMoreAfter) {
    const lastUserRow = await dbGet(
      db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.role, 'user')))
        .orderBy(desc(schema.messages.timestamp))
        .limit(1),
    );
    lastUserMessage = lastUserRow ?? lastUserMessage;
  }
  return lastUserMessage;
}

/** Enrich a context message (last / leading user prompt), reusing the window's copy when it has one. */
async function enrichContextMessage(
  deps: RepoDeps,
  message: MessageRow | undefined,
  outsideWindow: boolean | undefined,
  enrichedMessages: Awaited<ReturnType<typeof enrichMessages>>,
  allToolCalls: ToolCallRow[],
) {
  if (!message) return undefined;
  return outsideWindow
    ? (await enrichMessages(deps, [message], allToolCalls))[0]
    : enrichedMessages.find((m) => m.id === message.id);
}

function parseInitInfo(thread: ThreadRow) {
  // SAFETY: init_tools and init_slash_commands are written only as JSON.stringify
  // of the agent's init tool and slash-command name lists (string[]).
  return thread.initTools
    ? {
        tools: JSON.parse(thread.initTools) as string[],
        cwd: thread.initCwd ?? '',
        model: thread.model ?? '',
        slashCommands: thread.initSlashCommands
          ? (JSON.parse(thread.initSlashCommands) as string[])
          : undefined,
      }
    : undefined;
}

/** Get a thread with its messages and tool calls.
 *  When messageLimit is provided, returns ONLY the N most recent messages
 *  plus a hasMore flag — no server-side extension. The client extends the
 *  window in idle time via /messages, keeping the initial response small
 *  and the first paint fast. `lastUserMessage` is always included so the
 *  sticky prompt header can render immediately. */
export async function getThreadWithMessages(
  deps: RepoDeps,
  id: string,
  messageLimit?: number,
  opts: { messageProgress?: number; messageAnchorId?: string } = {},
) {
  const { db, schema, dbGet } = deps;
  const thread = await dbGet(db.select().from(schema.threads).where(eq(schema.threads.id, id)));
  if (!thread) return null;

  const window = await loadMessageWindow(deps, id, messageLimit, opts);
  const { messages, hasMore, hasMoreAfter, windowStart, total } = window;

  let leadingUserMessage: MessageRow | undefined;
  if (messageLimit && messages.length > 0 && messages[0].role !== 'user') {
    leadingUserMessage = await findLeadingUserMessage(deps, thread.id, messages[0]);
  }
  const lastUserMessage = await resolveLastUserMessage(deps, id, window);

  // Single batched tool-calls fetch covering messages + context-only user messages.
  const toolCallIds = messages.map((m) => m.id);
  const lastUserOutsideWindow =
    lastUserMessage && !messages.some((m) => m.id === lastUserMessage.id);
  if (lastUserOutsideWindow && lastUserMessage) toolCallIds.push(lastUserMessage.id);
  const leadingUserOutsideWindow =
    leadingUserMessage && !messages.some((m) => m.id === leadingUserMessage.id);
  if (leadingUserOutsideWindow && leadingUserMessage) toolCallIds.push(leadingUserMessage.id);

  const allToolCalls = await fetchToolCallsForMessages(deps, toolCallIds);

  const enrichedMessages = await enrichMessages(deps, messages, allToolCalls);
  const enrichedLastUser = await enrichContextMessage(
    deps,
    lastUserMessage,
    lastUserOutsideWindow,
    enrichedMessages,
    allToolCalls,
  );
  const enrichedLeadingUser = await enrichContextMessage(
    deps,
    leadingUserMessage,
    leadingUserOutsideWindow,
    enrichedMessages,
    allToolCalls,
  );
  const waitState = await findPendingWaitState(deps, id, thread.status);

  return {
    ...thread,
    messages: enrichedMessages,
    hasMore,
    hasMoreAfter,
    // When fully loaded (no messageLimit) the loaded window IS the total.
    total: total ?? enrichedMessages.length,
    windowStart,
    lastUserMessage: enrichedLastUser,
    leadingUserMessage: enrichedLeadingUser,
    initInfo: parseInitInfo(thread),
    ...waitState,
  };
}
