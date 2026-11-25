/**
 * Claude Code session JSONL entries: their schema, the session-level metadata
 * they carry, and how an entry becomes a transcript message.
 */

import type {
  ExternalClaudeTranscriptMessage,
  ExternalClaudeTranscriptToolCall,
  ImageAttachment,
} from '@funny/shared';
import { parseStoredJson, type JsonValue } from '@funny/shared/json-validation';
import { z } from 'zod';

import { isObject, isString } from '../../lib/value-guards.js';

const IDE_OPENED_FILE_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g;
const PREVIEWABLE_ASSETS_BLOCK_RE = /\[PREVIEWABLE ASSETS\][\s\S]*?\[\/PREVIEWABLE ASSETS\]/g;
const LOCAL_COMMAND_CAVEAT_BLOCK_RE =
  /<local-command-caveat>[\s\S]*?(?:<\/local-command-caveat>|$)/g;
const CONTEXT_RECOVERY_PREFIX =
  '[SYSTEM NOTE: Your previous session cannot be resumed. Below is the conversation history to restore context.';
const RESUME_NOTE_PREFIX =
  '[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution.';
const RECOVERED_USER_MESSAGE_MARKER = 'USER (new message):';
export const CLAUDE_CODE_SYNTHETIC_AUTHOR = 'Claude Code';
/** Claude Code's meta note naming the file a pasted image was saved to. */
const IMAGE_SOURCE_NOTE_RE = /^(?:\s*\[Image(?: #\d+)?: source: [^\]\n]+\]\s*)+$/;
/** Content blocks that never render as message text (images travel as attachments). */
const NON_TEXT_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'tool_use', 'image']);

const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string(),
  }),
});

/** A message's content as Claude Code writes it: a string or a list of blocks, unchecked. */
type TranscriptContent = JsonValue | undefined;

/** One field of a content block, as JSON. */
type BlockRecord = { [key: string]: JsonValue };

const claudeJsonlEntrySchema = z
  .object({
    type: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    timestamp: z.string().optional(),
    lastPrompt: z.string().optional(),
    aiTitle: z.string().optional(),
    summary: z.string().optional(),
    uuid: z.string().optional(),
    isMeta: z.boolean().optional(),
    message: z
      .object({
        role: z.enum(['user', 'assistant', 'system']).optional(),
        // The line was decoded by JSON.parse, so any value here is JSON; its
        // blocks are read one by one with their own checks.
        content: z.json().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface SessionMetadata {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  lastPrompt: string | null;
  /** Title Claude Code generated for the session (`ai-title` entries). */
  aiTitle: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  hasDisplayableContent: boolean;
}

/** Title shown for a session: Claude Code's generated title, else the last prompt. */
export function sessionTitle(
  metadata: Pick<SessionMetadata, 'aiTitle' | 'lastPrompt'> | null,
  fallback: string,
): string {
  return metadata?.aiTitle ?? metadata?.lastPrompt ?? fallback;
}

type ClaudeJsonlEntry = z.infer<typeof claudeJsonlEntrySchema>;

export function emptySessionMetadata(sessionId: string): SessionMetadata {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    lastPrompt: null,
    aiTitle: null,
    startedAt: null,
    updatedAt: null,
    hasDisplayableContent: false,
  };
}

/** One line of a session JSONL file as an entry; null for blank and invalid lines. */
export function parseJsonlEntry(line: string): ClaudeJsonlEntry | null {
  if (!line.trim()) return null;
  const parsed = parseStoredJson(claudeJsonlEntrySchema, line, 'Claude Code session JSONL');
  return parsed.ok ? parsed.value : null;
}

/** Fold one JSONL entry's session-level fields (ids, timestamps, prompt, title) into `metadata`. */
export function applyEntryMetadata(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  applyEntryContext(metadata, entry);
  applyEntryTitles(metadata, entry);
}

/** Session id, cwd, branch and the first / last timestamps. */
function applyEntryContext(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  if (entry.sessionId) metadata.sessionId = entry.sessionId;
  if (entry.cwd) metadata.cwd = entry.cwd;
  if (entry.gitBranch) metadata.gitBranch = entry.gitBranch;
  if (entry.timestamp) {
    metadata.startedAt ??= entry.timestamp;
    metadata.updatedAt = entry.timestamp;
  }
}

/** `last-prompt` and `ai-title` entries. */
function applyEntryTitles(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  if (entry.type === 'last-prompt' && entry.lastPrompt) {
    const lastPrompt = contentToText(entry.lastPrompt);
    if (lastPrompt) metadata.lastPrompt = lastPrompt;
  }
  const aiTitle = entry.type === 'ai-title' ? entry.aiTitle?.trim() : undefined;
  if (aiTitle) metadata.aiTitle = aiTitle;
}

function summaryTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
): ExternalClaudeTranscriptMessage | null {
  if (entry.type === 'summary' && entry.summary) {
    return {
      id: entry.uuid ?? `summary-${index}`,
      role: 'system',
      content: entry.summary,
      timestamp: entry.timestamp ?? null,
    };
  }
  return null;
}

/**
 * Newer Claude Code versions also log the raw API request (`api-request-blob`: system
 * prompt, tool definitions, reminders, a copy of the assistant turn) with a
 * `message.role`; only `user` / `assistant` entries are conversation.
 */
function isConversationEntry(entry: z.infer<typeof claudeJsonlEntrySchema>): boolean {
  return entry.type === 'user' || entry.type === 'assistant';
}

export function entryToTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptMessage | null {
  // Besides summaries, only conversation entries are messages.
  if (!isConversationEntry(entry)) return summaryTranscriptMessage(entry, index);

  const message = entry.message;
  const role = message?.role;
  if (!role || message.content === undefined) return null;

  if (role === 'user' && contentLooksLikeToolResult(message.content)) {
    return toolResultTranscriptMessage(entry, message.content, index, toolCallsByClaudeId);
  }

  const content = contentToText(message.content);
  const parts =
    role === 'user'
      ? userMessageParts(entry, message.content, content)
      : { toolCalls: extractToolCalls(message.content, entry, index, toolCallsByClaudeId) };
  if (!parts || !hasVisibleContent(content, parts)) return null;

  return {
    id: entry.uuid ?? `${role}-${index}`,
    role,
    content,
    ...withoutEmptyLists(parts),
    timestamp: entry.timestamp ?? null,
  };
}

/** A user turn of bare tool results: fills earlier tool cards, keeping only orphans. */
function toolResultTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  content: TranscriptContent,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptMessage | null {
  const orphanToolCalls = applyToolResults(content, entry, index, toolCallsByClaudeId);
  if (orphanToolCalls.length === 0) return null;
  return {
    id: entry.uuid ?? `tool-results-${index}`,
    role: 'assistant',
    content: '',
    timestamp: entry.timestamp ?? null,
    toolCalls: orphanToolCalls,
  };
}

function hasVisibleContent(
  content: string,
  parts: Pick<ExternalClaudeTranscriptMessage, 'images' | 'toolCalls'>,
): boolean {
  return content.trim().length > 0 || !!parts.toolCalls?.length || !!parts.images?.length;
}

/** Attachments and authorship of a user turn, or null when the turn is not shown. */
function userMessageParts(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  rawContent: TranscriptContent,
  content: string,
): Pick<ExternalClaudeTranscriptMessage, 'images' | 'author' | 'toolCalls'> | null {
  if (!entry.isMeta) return { images: extractImages(rawContent) };
  // Claude Code follows a pasted image with a meta note holding only its temp path.
  if (IMAGE_SOURCE_NOTE_RE.test(content)) return null;
  return { images: extractImages(rawContent), author: CLAUDE_CODE_SYNTHETIC_AUTHOR };
}

function withoutEmptyLists<T extends Record<string, unknown>>(parts: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(parts).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as Partial<T>;
}

function extractToolCalls(
  content: TranscriptContent,
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptToolCall[] {
  if (!Array.isArray(content)) return [];

  const toolCalls: ExternalClaudeTranscriptToolCall[] = [];
  content.forEach((block, blockIndex) => {
    if (!isObject(block)) return;
    const record = block as BlockRecord;
    if (record.type !== 'tool_use') return;

    const claudeToolId = isString(record.id) ? record.id : null;
    const toolCall: ExternalClaudeTranscriptToolCall = {
      id: claudeToolId ?? `${entry.uuid ?? `assistant-${index}`}-tool-${blockIndex}`,
      name: isString(record.name) && record.name ? record.name : 'Tool',
      input: stringifyToolInput(record.input),
      timestamp: entry.timestamp ?? null,
      author: 'Claude Code',
    };
    toolCalls.push(toolCall);
    if (claudeToolId) toolCallsByClaudeId.set(claudeToolId, toolCall);
  });

  return toolCalls;
}

function applyToolResults(
  content: TranscriptContent,
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptToolCall[] {
  if (!Array.isArray(content)) return [];

  const orphanToolCalls: ExternalClaudeTranscriptToolCall[] = [];
  content.forEach((block, blockIndex) => {
    if (!isObject(block)) return;
    const record = block as BlockRecord;
    if (record.type !== 'tool_result') return;

    const output = contentToText(record.content);
    const claudeToolId = isString(record.tool_use_id) ? record.tool_use_id : null;
    const existing = claudeToolId ? toolCallsByClaudeId.get(claudeToolId) : null;
    if (existing) {
      existing.output = output;
      return;
    }

    orphanToolCalls.push({
      id: claudeToolId ?? `${entry.uuid ?? `tool-result-${index}`}-tool-${blockIndex}`,
      name: 'ToolResult',
      input: '{}',
      output,
      timestamp: entry.timestamp ?? null,
      author: 'Claude Code',
    });
  });

  return orphanToolCalls;
}

export function contentToText(content: TranscriptContent): string {
  const text = isString(content)
    ? content
    : !Array.isArray(content)
      ? stringifyJson(content)
      : content
          .map((block) => blockToText(block))
          .filter(Boolean)
          .join('\n\n');

  return stripClaudeInternalPromptMarkers(stripIdeOpenedFileMarkers(text));
}

function extractImages(content: TranscriptContent): ImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ImageAttachment[] => {
    const parsed = imageBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function blockToText(block: JsonValue): string {
  if (isString(block)) return block;
  if (!isObject(block)) return stringifyJson(block);

  const record = block as BlockRecord;
  const type = isString(record.type) ? record.type : null;

  if (type === 'text' && isString(record.text)) return record.text;
  if (type && NON_TEXT_BLOCK_TYPES.has(type)) return '';
  if (type === 'tool_result') {
    return `Tool result\n\n${contentToText(record.content)}`;
  }

  if (isString(record.text)) return record.text;
  if (isString(record.content)) return record.content;
  return stringifyJson(record);
}

function contentLooksLikeToolResult(content: TranscriptContent): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isObject(block) && (block as BlockRecord).type === 'tool_result')
  );
}

function stringifyToolInput(input: TranscriptContent): string {
  if (input === null || input === undefined) return '{}';
  if (isString(input)) return input;
  return stringifyJson(input) || '{}';
}

function stringifyJson(value: TranscriptContent): string {
  if (value === null || value === undefined) return '';
  if (isString(value)) return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stripIdeOpenedFileMarkers(value: string): string {
  if (!value.includes('<ide_opened_file>')) return value;
  return value
    .replace(IDE_OPENED_FILE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripClaudeInternalPromptMarkers(value: string): string {
  if (!containsClaudeInternalPromptMarker(value)) return value;

  const trimmedStart = value.trimStart();
  if (trimmedStart.startsWith(CONTEXT_RECOVERY_PREFIX)) {
    const markerIndex = trimmedStart.lastIndexOf(RECOVERED_USER_MESSAGE_MARKER);
    if (markerIndex === -1) return '';
    return trimmedStart
      .slice(markerIndex + RECOVERED_USER_MESSAGE_MARKER.length)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (trimmedStart.startsWith(RESUME_NOTE_PREFIX)) {
    const noteEnd = trimmedStart.indexOf(']');
    return (noteEnd === -1 ? '' : trimmedStart.slice(noteEnd + 1))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const stripped = value
    .replace(PREVIEWABLE_ASSETS_BLOCK_RE, '')
    .replace(LOCAL_COMMAND_CAVEAT_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const remaining = stripped.trimStart();
  if (
    remaining.startsWith('[PREVIEWABLE ASSETS]') ||
    remaining.startsWith('<local-command-caveat>')
  ) {
    return '';
  }

  return stripped;
}

function containsClaudeInternalPromptMarker(value: string): boolean {
  return (
    value.includes('[PREVIEWABLE ASSETS]') ||
    value.includes('<local-command-caveat>') ||
    value.includes(CONTEXT_RECOVERY_PREFIX) ||
    value.includes(RESUME_NOTE_PREFIX)
  );
}

export function firstLine(value: string): string | null {
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : null;
}
