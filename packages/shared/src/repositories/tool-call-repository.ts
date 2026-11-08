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

import { eq, and, isNull, inArray, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { parseStoredJson } from '../json-validation.js';
import type { RepoDeps } from './deps.js';

export type ToolCallRepositoryDeps = RepoDeps;

export function createToolCallRepository(deps: ToolCallRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;

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

  /**
   * Get unique file paths touched by file-modifying tool calls (Write, Edit, NotebookEdit)
   * for a given thread. Queries ALL tool calls regardless of message pagination.
   *
   * A Write's input holds the whole file, so only the first bytes of each input
   * are read: the path is a leading top-level key in practice. A row whose
   * prefix does not settle it (path after a large value, or truncated) falls
   * back to its full input, so the result matches parsing every input.
   */
  async function getTouchedFiles(threadId: string): Promise<string[]> {
    const FILE_MODIFYING_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
    const rows = await dbAll<{ id: string; head: string | null }>(
      db
        .select({
          id: schema.toolCalls.id,
          head: sql<
            string | null
          >`substr(${schema.toolCalls.input}, 1, ${sql.raw(String(TOUCHED_FILE_PREFIX_CHARS))})`,
        })
        .from(schema.toolCalls)
        .innerJoin(schema.messages, eq(schema.toolCalls.messageId, schema.messages.id))
        .where(
          and(
            eq(schema.messages.threadId, threadId),
            inArray(schema.toolCalls.name, FILE_MODIFYING_TOOLS),
          ),
        ),
    );

    const paths = new Set<string>();
    const unresolved: string[] = [];
    for (const row of rows) {
      if (!row.head) continue;
      const fromPrefix = touchedPathFromPrefix(row.head);
      if (fromPrefix === undefined) unresolved.push(row.id);
      else if (fromPrefix) paths.add(fromPrefix);
    }

    for (let i = 0; i < unresolved.length; i += 500) {
      const full = await dbAll<{ input: string | null }>(
        db
          .select({ input: schema.toolCalls.input })
          .from(schema.toolCalls)
          .where(inArray(schema.toolCalls.id, unresolved.slice(i, i + 500))),
      );
      for (const row of full) {
        const fp = touchedPathFromInput(row.input);
        if (fp) paths.add(fp);
      }
    }
    return Array.from(paths).sort();
  }

  return {
    insertToolCall,
    updateToolCallOutput,
    findToolCall,
    getToolCall,
    findLastUnansweredInteractiveToolCall,
    getTouchedFiles,
  };
}

/** The path keys of a tool input; every other key passes through unchecked. */
const TOOL_INPUT_PATHS = z
  .object({ file_path: z.unknown().optional(), notebook_path: z.unknown().optional() })
  .passthrough();

/** Leading characters of a tool input read to find its file path. */
const TOUCHED_FILE_PREFIX_CHARS = 1024;

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const JSON_SCALAR = String.raw`(?:${JSON_STRING}|-?\d[\d.eE+-]*|true|false|null)`;
/** `{` followed by any leading flat `"key": scalar,` pairs, then a path key. */
const LEADING_PATH_KEY = new RegExp(
  String.raw`^\s*\{\s*(?:${JSON_STRING}\s*:\s*${JSON_SCALAR}\s*,\s*)*?"(file_path|notebook_path)"\s*:\s*(${JSON_STRING})`,
);

/**
 * The file path from the start of a tool input, or `undefined` when the
 * prefix cannot settle it and the full input must be parsed. Only flat
 * top-level pairs are walked, so a key inside a nested value never matches.
 */
function touchedPathFromPrefix(head: string): string | null | undefined {
  const match = LEADING_PATH_KEY.exec(head);
  if (!match) return undefined;
  // file_path wins over notebook_path, as in the full parse: if notebook_path
  // came first, file_path might still follow.
  if (match[1] === 'notebook_path') return undefined;
  const value = parseStoredJson(z.string(), match[2], 'tool input path');
  if (!value.ok) return undefined;
  return value.value || null;
}

function touchedPathFromInput(input: string | null): string | null {
  if (!input) return null;
  const parsed = parseStoredJson(TOOL_INPUT_PATHS, input, 'tool input');
  if (!parsed.ok) return null; // skip invalid JSON
  const fp = parsed.value.file_path ?? parsed.value.notebook_path ?? null;
  return typeof fp === 'string' && fp ? fp : null;
}
