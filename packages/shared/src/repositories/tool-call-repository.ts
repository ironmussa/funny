/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 *
 * DB-agnostic tool call repository. Accepts db + schema via dependency injection.
 */

import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { AppDatabase, dbGet as dbGetFn, dbRun as dbRunFn } from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface ToolCallRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export function createToolCallRepository(deps: ToolCallRepositoryDeps) {
  const { db, schema, dbGet, dbRun } = deps;

  /** Insert a new tool call, returns the generated ID */
  async function insertToolCall(data: {
    messageId: string;
    name: string;
    input: string;
    author?: string | null;
    parentToolCallId?: string | null;
  }): Promise<string> {
    const id = nanoid();
    await dbRun(
      db.insert(schema.toolCalls).values({
        id,
        messageId: data.messageId,
        name: data.name,
        input: data.input,
        author: data.author ?? null,
        parentToolCallId: data.parentToolCallId ?? null,
      }),
    );
    return id;
  }

  /** Update tool call output */
  async function updateToolCallOutput(id: string, output: string) {
    await dbRun(db.update(schema.toolCalls).set({ output }).where(eq(schema.toolCalls.id, id)));
  }

  /** Find existing tool call by messageId + name + input (for deduplication) */
  async function findToolCall(messageId: string, name: string, input: string) {
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
  async function getToolCall(id: string) {
    return dbGet(db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, id)));
  }

  /** Find the last unanswered AskUserQuestion/ExitPlanMode tool call for a thread */
  async function findLastUnansweredInteractiveToolCall(threadId: string) {
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

  return {
    insertToolCall,
    updateToolCallOutput,
    findToolCall,
    getToolCall,
    findLastUnansweredInteractiveToolCall,
  };
}
