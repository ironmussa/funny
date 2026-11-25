/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * Reads the structured result of a read-only factory role (change
 * factory-agent-roles, D2). A role's prompt asks for one fenced `json` block
 * at the end of its final message; the server takes the LAST such block,
 * validates it against the role's schema, and on failure asks once, on the
 * same thread, to emit it again. Still invalid: the caller applies the role's
 * failure rule (a review fails closed).
 *
 * The result is model output about untrusted input (an issue, a diff): it is
 * data to validate, never an instruction.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import type { z } from 'zod';

/** The opening of a fenced block tagged `json` (three or more backticks), at a line start. */
const JSON_FENCE_OPEN = /^[ \t]*(`{3,})[ \t]*json[ \t]*$/i;

/** Larger blocks are refused unread: a result is a verdict, not a document. */
const MAX_RESULT_CHARS = 100_000;

/**
 * The shell rule every read-only role's prompt carries. Its Bash runs in the
 * SDK's sandbox, whose wrapper keeps two proxies as background jobs of the
 * same shell: a bare `wait` waits for them forever, and the Claude CLI does
 * not end a turn while a shell job it put in the background still runs.
 * Seen in a real review: the verdict was written, the thread stayed running.
 */
export const READ_ONLY_SHELL_RULE =
  'Your shell runs in a sandbox that keeps helper processes of its own in the background, so a bare `wait` never returns and your turn would never end. To wait for a command you put in the background, wait for its pid (`cmd & pid=$!; ...; wait $pid`), or run the commands one after another.';

/**
 * The text of the last fenced `json` block of a message, or null when it has
 * none. A block ends at the next line holding only a fence at least as long as
 * its opening one; an unclosed block runs to the end of the message.
 */
export function lastJsonBlock(message: string): string | null {
  const lines = message.split(/\r?\n/);
  let last: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const open = JSON_FENCE_OPEN.exec(lines[index] ?? '');
    index += 1;
    if (!open) continue;
    const fence = open[1] ?? '```';
    const body: string[] = [];
    while (index < lines.length && !isClosingFence(lines[index] ?? '', fence)) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    index += 1;
    last = body.join('\n');
  }
  return last;
}

function isClosingFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && /^`+$/.test(trimmed);
}

/** A message's result, validated; the error says what to fix, for the re-emit request. */
export function parseRoleResult<Schema extends z.ZodType>(
  schema: Schema,
  message: string | null,
): Result<z.output<Schema>, string> {
  if (!message) return err('the final message is empty');
  const block = lastJsonBlock(message);
  if (block === null) return err('the final message has no fenced json block');
  if (block.length > MAX_RESULT_CHARS) return err('the json block is too large');
  const parsed = parseStoredJson(schema, block, 'result');
  if (parsed.ok) return ok(parsed.value);
  // No issues: the text is not JSON at all (the parser's own message may quote it).
  if (parsed.issues.length === 0) return err('the json block is not valid JSON');
  const problems = parsed.issues
    .slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return err(`the json block does not match the result format (${problems})`);
}

/** What the re-emit follow-up says. It carries the problem, never the invalid text back. */
function reemitPrompt(problem: string): string {
  return [
    `Your final message could not be read as a result: ${problem}.`,
    'Reply with the result again as ONE fenced json block in the format you were given, and nothing after it.',
    'Do not change your conclusion; only fix the format.',
  ].join('\n');
}

export interface RoleResultError {
  /** Why the result could not be read, after the re-emit request. */
  reason: string;
  /** Whether the agent was asked again (false when asking itself failed). */
  asked: boolean;
}

export interface RoleResultPorts {
  /** The thread's final assistant message now. */
  finalMessage(): Promise<string | null>;
  /**
   * Send `prompt` as a follow-up on the same thread, wait for the agent to
   * finish, and answer its new final message; an error when the follow-up
   * could not be sent or the agent did not finish.
   */
  askAgain(prompt: string): Promise<Result<string | null, string>>;
}

/**
 * A role's validated result: read from the final message, with one request to
 * emit it again when it is missing or invalid.
 */
export async function readRoleResult<Schema extends z.ZodType>(
  schema: Schema,
  ports: RoleResultPorts,
): Promise<Result<z.output<Schema>, RoleResultError>> {
  const first = parseRoleResult(schema, await ports.finalMessage());
  if (first.isOk()) return ok(first.value);
  const again = await ports.askAgain(reemitPrompt(first.error));
  if (again.isErr()) return err({ reason: `${first.error}; ${again.error}`, asked: false });
  const second = parseRoleResult(schema, again.value);
  if (second.isOk()) return ok(second.value);
  return err({ reason: second.error, asked: true });
}
