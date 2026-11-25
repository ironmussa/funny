/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The compact transcript a thread recap is generated from (openspec
 * `thread-recap`, D2). Pure: it takes the thread's stored rows (the same shape
 * for every agent provider) and keeps only what a three-sentence summary
 * needs — user and assistant text, each tool call's name with a one-line
 * summary of its input and a short excerpt of its output, what the agent is
 * waiting on, and the thread's status. Only entries after `since` count, and
 * the newest are kept within a fixed size, so thousands of new messages still
 * produce a bounded input.
 */

import { parseStoredJson, type JsonValue } from '@funny/shared/json-validation';
import { z } from 'zod';

/** A tool call as stored (`tool_calls` row): input and output are raw strings. */
export interface RecapToolCall {
  name: string;
  input?: string | null;
  output?: string | null;
}

/** A message as stored (`messages` row) with its tool calls. */
export interface RecapMessage {
  id: string;
  role: string;
  content?: string | null;
  timestamp: string;
  toolCalls?: RecapToolCall[] | null;
}

export interface RecapTranscriptInput {
  /** The owner's last read time (ISO). Only activity after it is kept. */
  since: string;
  /** `threads.status`. */
  status?: string | null;
  /** Set by the server's thread read when the thread is `waiting`. */
  waitingReason?: string | null;
  pendingPermission?: { toolName: string; toolInput?: string | null } | null;
  /** Oldest first. */
  messages: RecapMessage[];
}

export interface RecapTranscript {
  /** The transcript text, or `''` when nothing happened after `since`. */
  text: string;
  /** Entries after `since`. */
  entryCount: number;
  /** Entries left out to stay within the size limit (the oldest ones). */
  omittedCount: number;
}

/** Total size of the transcript, in characters. */
export const RECAP_TRANSCRIPT_MAX_CHARS = 12_000;
/** Size of the excerpt kept from each tool output. */
const TOOL_OUTPUT_EXCERPT_CHARS = 300;
/** Size of the one-line tool input summary. */
const TOOL_INPUT_SUMMARY_CHARS = 160;
/** A single message never fills the whole budget on its own. */
const MESSAGE_TEXT_MAX_CHARS = 2_000;

/** Input keys that name what a tool call acts on, most telling first. */
const INPUT_SUMMARY_KEYS = [
  'command',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
  'content',
] as const;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A stored tool input: its JSON value, or the raw text when it is not JSON. */
function parseInput(raw: string): JsonValue {
  const parsed = parseStoredJson(z.json(), raw, 'tool call input');
  return parsed.ok ? parsed.value : raw;
}

/** The pending question's text, from an `AskUserQuestion` input. */
function questionText(input: JsonValue): string | null {
  if (!input || typeof input !== 'object') return null;
  const questions = (input as { questions?: unknown }).questions;
  if (Array.isArray(questions)) {
    const texts = questions
      .map((q) => (q && typeof q === 'object' ? (q as { question?: unknown }).question : null))
      .filter((q): q is string => typeof q === 'string' && q.length > 0);
    if (texts.length > 0) return texts.join(' / ');
  }
  const question = (input as { question?: unknown }).question;
  return typeof question === 'string' ? question : null;
}

/** One line saying what a tool call acted on: a telling field, else its compact JSON. */
export function summarizeToolInput(raw: string | null | undefined): string {
  if (!raw) return '';
  const input = parseInput(raw);
  if (typeof input === 'string') return clip(oneLine(input), TOOL_INPUT_SUMMARY_CHARS);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const question = questionText(input);
    if (question) return clip(oneLine(question), TOOL_INPUT_SUMMARY_CHARS);
    const record = input as Record<string, unknown>;
    for (const key of INPUT_SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return clip(oneLine(value), TOOL_INPUT_SUMMARY_CHARS);
      }
    }
  }
  return clip(oneLine(JSON.stringify(input) ?? ''), TOOL_INPUT_SUMMARY_CHARS);
}

function excerpt(output: string | null | undefined): string {
  if (!output) return '';
  return clip(oneLine(output), TOOL_OUTPUT_EXCERPT_CHARS);
}

function toolEntry(call: RecapToolCall): string {
  const summary = summarizeToolInput(call.input);
  const head = summary ? `Tool ${call.name}: ${summary}` : `Tool ${call.name}`;
  const out = excerpt(call.output);
  return out ? `${head}\n  → ${out}` : `${head}\n  → (no output yet)`;
}

function messageEntries(message: RecapMessage): string[] {
  const entries: string[] = [];
  const text = oneLine(message.content ?? '');
  if (text && (message.role === 'user' || message.role === 'assistant')) {
    const who = message.role === 'user' ? 'User' : 'Agent';
    entries.push(`${who}: ${clip(text, MESSAGE_TEXT_MAX_CHARS)}`);
  }
  for (const call of message.toolCalls ?? []) entries.push(toolEntry(call));
  return entries;
}

function isAfter(timestamp: string, since: number): boolean {
  const at = Date.parse(timestamp);
  // A row whose time cannot be read is kept rather than silently dropped.
  return Number.isNaN(at) || at > since;
}

/** The pending interactive tool call, if the agent's last one is unanswered. */
function pendingQuestion(messages: RecapMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = messages[i].toolCalls ?? [];
    for (let j = calls.length - 1; j >= 0; j--) {
      const call = calls[j];
      if (call.name === 'AskUserQuestion' && !call.output) {
        return questionText(call.input ? parseInput(call.input) : null);
      }
    }
  }
  return null;
}

/** What the agent waits on the user for, as one line, or null. */
function waitingLine(input: RecapTranscriptInput): string | null {
  if (input.status !== 'waiting') return null;
  switch (input.waitingReason) {
    case 'permission': {
      const pending = input.pendingPermission;
      if (!pending) return 'Waiting on the user: an approval of a tool call.';
      const summary = summarizeToolInput(pending.toolInput);
      return `Waiting on the user: approval to run ${pending.toolName}${summary ? ` (${summary})` : ''}.`;
    }
    case 'question': {
      const question = pendingQuestion(input.messages);
      return question
        ? `Waiting on the user: an answer to the question "${clip(oneLine(question), TOOL_INPUT_SUMMARY_CHARS)}".`
        : 'Waiting on the user: an answer to a question.';
    }
    case 'plan':
      return 'Waiting on the user: approval of a plan.';
    default:
      return 'Waiting on the user.';
  }
}

/**
 * The compact transcript of a thread's activity after `since`, newest entries
 * kept within `maxChars`. Empty when nothing happened after `since`.
 */
export function buildRecapTranscript(
  input: RecapTranscriptInput,
  opts: { maxChars?: number } = {},
): RecapTranscript {
  const maxChars = opts.maxChars ?? RECAP_TRANSCRIPT_MAX_CHARS;
  const since = Date.parse(input.since);
  const recent = input.messages.filter((m) =>
    Number.isNaN(since) ? true : isAfter(m.timestamp, since),
  );
  const entries = recent.flatMap(messageEntries);
  if (entries.length === 0) return { text: '', entryCount: 0, omittedCount: 0 };

  const state = [`Thread status: ${input.status ?? 'unknown'}.`];
  const waiting = waitingLine(input);
  if (waiting) state.push(waiting);
  const footer = `\n\nCurrent state:\n${state.join('\n')}`;

  // Newest first until the budget is spent; the footer and the omission note
  // are always kept, so they are paid for up front.
  const header = 'Activity since the user last read the thread:\n';
  const omissionNoteChars = 48;
  let budget = maxChars - header.length - footer.length - omissionNoteChars;
  const kept: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + 1;
    if (cost > budget) break;
    kept.push(entries[i]);
    budget -= cost;
  }
  kept.reverse();
  const omittedCount = entries.length - kept.length;
  const note = omittedCount > 0 ? `[${omittedCount} earlier entries omitted]\n` : '';
  return {
    text: `${header}${note}${kept.join('\n')}${footer}`,
    entryCount: entries.length,
    omittedCount,
  };
}
