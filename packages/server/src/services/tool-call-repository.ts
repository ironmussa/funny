/**
 * ToolCall CRUD operations.
 * Extracted from thread-manager.ts for single-responsibility.
 */

import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

/** Insert a new tool call, returns the generated ID */
export function insertToolCall(data: {
  messageId: string;
  name: string;
  input: string;
  author?: string | null;
}): string {
  const id = nanoid();
  db.insert(schema.toolCalls)
    .values({
      id,
      messageId: data.messageId,
      name: data.name,
      input: data.input,
      author: data.author ?? null,
    })
    .run();
  return id;
}

/** Update tool call output */
export function updateToolCallOutput(id: string, output: string) {
  db.update(schema.toolCalls)
    .set({ output })
    .where(eq(schema.toolCalls.id, id))
    .run();
}

/** Find existing tool call by messageId + name + input (for deduplication) */
export function findToolCall(messageId: string, name: string, input: string) {
  return db.select({ id: schema.toolCalls.id })
    .from(schema.toolCalls)
    .where(and(
      eq(schema.toolCalls.messageId, messageId),
      eq(schema.toolCalls.name, name),
      eq(schema.toolCalls.input, input),
    ))
    .get();
}

/** Get a single tool call by ID */
export function getToolCall(id: string) {
  return db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, id)).get();
}

/** Find the last unanswered AskUserQuestion/ExitPlanMode tool call for a thread */
export function findLastUnansweredInteractiveToolCall(threadId: string) {
  const INTERACTIVE_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
  return db.select({
      id: schema.toolCalls.id,
      name: schema.toolCalls.name,
    })
    .from(schema.toolCalls)
    .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
    .where(and(
      eq(schema.messages.threadId, threadId),
      inArray(schema.toolCalls.name, INTERACTIVE_TOOLS),
      isNull(schema.toolCalls.output),
    ))
    .orderBy(desc(schema.messages.timestamp))
    .limit(1)
    .get();
}
