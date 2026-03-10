/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 */

import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbGet, dbRun, schema } from '../db/index.js';

/** Insert a new tool call, returns the generated ID */
export async function insertToolCall(data: {
  messageId: string;
  name: string;
  input: string;
  author?: string | null;
}): Promise<string> {
  const id = nanoid();
  await dbRun(
    db.insert(schema.toolCalls).values({
      id,
      messageId: data.messageId,
      name: data.name,
      input: data.input,
      author: data.author ?? null,
    }),
  );
  return id;
}

/** Update tool call output */
export async function updateToolCallOutput(id: string, output: string) {
  await dbRun(db.update(schema.toolCalls).set({ output }).where(eq(schema.toolCalls.id, id)));
}

/** Find existing tool call by messageId + name + input (for deduplication) */
export async function findToolCall(messageId: string, name: string, input: string) {
  return dbGet(
    db
      .select({ id: schema.toolCalls.id })
      .from(schema.toolCalls)
      .where(
        and(
          eq(schema.toolCalls.messageId, messageId),
          eq(schema.toolCalls.name, name),
          eq(schema.toolCalls.input, input),
        ),
      ),
  );
}

/** Get a single tool call by ID */
export async function getToolCall(id: string) {
  return dbGet(db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, id)));
}

/** Find the last unanswered AskUserQuestion/ExitPlanMode tool call for a thread */
export async function findLastUnansweredInteractiveToolCall(threadId: string) {
  const INTERACTIVE_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
  return dbGet(
    db
      .select({
        id: schema.toolCalls.id,
        name: schema.toolCalls.name,
      })
      .from(schema.toolCalls)
      .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          inArray(schema.toolCalls.name, INTERACTIVE_TOOLS),
          isNull(schema.toolCalls.output),
        ),
      )
      .orderBy(desc(schema.messages.timestamp))
      .limit(1),
  );
}
