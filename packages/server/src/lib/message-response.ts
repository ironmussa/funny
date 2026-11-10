/**
 * Message and tool-call rows (as `messageRepo.enrichMessages` returns them,
 * with parsed images and their tool calls) → the `Message` / `ToolCall` the
 * HTTP contract declares: optional fields are absent instead of null.
 *
 * The repository keeps returning rows because the runner data channel reads
 * them; HTTP responses go through here.
 */

import type {
  AgentModel,
  EffortLevel,
  ImageAttachment,
  Message,
  MessageRole,
  PermissionMode,
  ToolCall,
} from '@funny/shared';

import type { messages, toolCalls } from '../db/schema.js';

type ToolCallRow = typeof toolCalls.$inferSelect & { timestamp?: string | null };

/** A message row after enrichment: images parsed, tool calls attached. */
type EnrichedMessageRow = Omit<typeof messages.$inferSelect, 'images'> & {
  images?: ImageAttachment[] | null;
  toolCalls?: ToolCallRow[];
};

export type MessageWithToolCalls = Message & { toolCalls?: ToolCall[] };

function toToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    messageId: row.messageId,
    name: row.name,
    // Tool calls are always written with an input; a legacy row without one
    // reads as "no arguments" so the client's JSON.parse(input) still works.
    input: row.input ?? '{}',
    output: row.output ?? undefined,
    timestamp: row.timestamp ?? undefined,
    author: row.author ?? undefined,
    parentToolCallId: row.parentToolCallId ?? undefined,
  };
}

export function toMessage(row: EnrichedMessageRow): MessageWithToolCalls {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as MessageRole,
    content: row.content,
    images: row.images ?? undefined,
    timestamp: row.timestamp,
    model: (row.model ?? undefined) as AgentModel | undefined,
    permissionMode: (row.permissionMode ?? undefined) as PermissionMode | undefined,
    effort: (row.effort ?? undefined) as EffortLevel | undefined,
    author: row.author ?? undefined,
    toolCalls: row.toolCalls?.map(toToolCall),
  };
}

export function toOptionalMessage(
  row: EnrichedMessageRow | null | undefined,
): MessageWithToolCalls | undefined {
  return row ? toMessage(row) : undefined;
}
