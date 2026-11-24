/**
 * Pure helpers of the agent message handler: text decoding, tool input /
 * result normalization, result classification and token usage. Split out of
 * agent-message-handler.ts.
 */

import type { CLIMessage } from '@funny/core/agents';
import type { FileDiffSummary } from '@funny/shared';

/**
 * Decode literal Unicode escape sequences (\uXXXX) that may appear
 * in CLI output when the text was double-encoded or the CLI emits
 * escaped Unicode instead of raw UTF-8 characters.
 */
export function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Normalize a tool_result `content` field to a string. The Anthropic SDK may
 * deliver it as a plain string or as an array of content blocks
 * (`[{ type: 'text', text: '…' }, …]`). Image / non-text blocks are rendered
 * as a placeholder so callers always see a non-empty string when there is
 * any payload at all.
 */
export function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          if (typeof b.text === 'string') return b.text;
          if (b.type === 'image') return '[image]';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Serialize a tool's input to a short string for client display in the
 * permission approval card. Bash gets its raw command; other tools get
 * a truncated JSON representation.
 */
export function serializeToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (toolName === 'Bash' && 'command' in input && typeof (input as any).command === 'string') {
    return (input as any).command as string;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return undefined;
  }
}

type ResultMessage = CLIMessage & { type: 'result' };

/** Machine event for a result: a wait wins, then success without a provider error. */
export function resultEventType(
  isWaitingForUser: boolean,
  subtype: ResultMessage['subtype'],
  providerError: string | undefined,
): 'WAIT' | 'COMPLETE' | 'FAIL' {
  if (isWaitingForUser) return 'WAIT';
  return subtype === 'success' && providerError === undefined ? 'COMPLETE' : 'FAIL';
}

/** `errorReason` + `error` for a failed result: the provider error, else the result or errors array. */
export function resultErrorFields(
  msg: ResultMessage,
  providerError: string | undefined,
): { errorReason: string; error: string | undefined } {
  if (providerError !== undefined) return { errorReason: 'provider_error', error: providerError };
  const error = msg.result ? decodeUnicodeEscapes(msg.result) : (msg.errors?.[0] ?? undefined);
  return { errorReason: msg.subtype, error };
}

/** Fill +/- for stat-less files from `stats`; files that already have stats are kept. */
export function backfillStats(
  files: FileDiffSummary[],
  stats: Map<string, { additions: number; deletions: number }>,
): FileDiffSummary[] {
  return files.map((f) => {
    const s = f.additions == null ? stats.get(f.path) : undefined;
    return s ? { ...f, additions: s.additions, deletions: s.deletions } : f;
  });
}

/**
 * Per-message context usage, or undefined when the message has none.
 * With prompt caching, the Anthropic API splits input tokens across:
 *   input_tokens — uncached (new) tokens only (often very small, e.g. 1-4)
 *   cache_read_input_tokens — tokens served from cache (the bulk)
 *   cache_creation_input_tokens — tokens being cached for the first time
 * The total = input_tokens + cache_read + cache_creation represents the
 * **full context window size** for this API call, not an incremental addition.
 * So the latest totalInputTokens is the context window usage, rather than an
 * accumulation across messages (which would vastly overcount).
 * The compaction-summary assistant message carries a `compaction` content
 * block and reports `usage` equal to the FULL pre-compaction context it
 * just read to build the summary. The SDK emits it AFTER the
 * `compact_boundary` system message, so forwarding its usage as an
 * `agent:context_usage` event would clobber the reset the client just
 * applied on the boundary — leaving the context-usage ring frozen at the
 * pre-compaction value (the "compacted but the meter didn't move" bug).
 * The boundary is authoritative for post-compaction usage, so it has none.
 */
export function assistantUsage(message: (CLIMessage & { type: 'assistant' })['message']) {
  const isCompactionSummary = message.content.some(
    (b: any) => b && typeof b === 'object' && 'type' in b && b.type === 'compaction',
  );
  const usage = isCompactionSummary
    ? undefined
    : (message.usage as Record<string, unknown> | undefined);
  if (!usage) return undefined;
  const inputTokens =
    (usage.input_tokens as number) ?? (usage.inputTokens as number) ?? (usage.used as number) ?? 0;
  const cacheRead =
    (usage.cache_read_input_tokens as number) ??
    (usage.cachedReadTokens as number) ??
    (usage.cacheReadTokens as number) ??
    0;
  const cacheCreation =
    (usage.cache_creation_input_tokens as number) ??
    (usage.cachedWriteTokens as number) ??
    (usage.cacheWriteTokens as number) ??
    0;
  const outputTokens = (usage.output_tokens as number) ?? (usage.outputTokens as number) ?? 0;
  return {
    raw: usage,
    inputTokens,
    cacheRead,
    cacheCreation,
    outputTokens,
    totalInputTokens: inputTokens + cacheRead + cacheCreation,
  };
}
