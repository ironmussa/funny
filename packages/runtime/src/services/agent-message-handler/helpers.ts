/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: application
 */

import type { CLIAssistantMessage, CLIMessage } from '@funny/core/agents';
import type { FileDiffSummary, ThreadStage } from '@funny/shared';
import { THREAD_STAGE_VALUES } from '@funny/shared/contracts/threads';

import { isObject, isString } from '../../lib/value-guards.js';

/**
 * Decode literal Unicode escape sequences (\uXXXX) that may appear
 * in CLI output when the text was double-encoded or the CLI emits
 * escaped Unicode instead of raw UTF-8 characters.
 */
export function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** A tool_use block of an assistant message, as the CLI protocol carries it. */
export type ToolUseBlock = Extract<
  CLIAssistantMessage['message']['content'][number],
  { type: 'tool_use' }
>;

/** A tool's input: the protocol leaves it opaque, so every reader checks its shape. */
export type ToolInput = ToolUseBlock['input'];

/** One part of a tool_result's content: text, or an SDK content block. */
type ToolResultContentPart = string | { type?: string; text?: string } | null;

/** A tool_result's `content`: the CLI sends text, the SDK may send content blocks. */
type ToolResultContent = string | readonly ToolResultContentPart[] | undefined;

/** A stored stage, when it is one of the stages the client draws. */
export function knownStage(stage: string | null | undefined): ThreadStage | undefined {
  return THREAD_STAGE_VALUES.find((value) => value === stage);
}

/** A tool_result content block, before its fields are checked. */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize a tool_result `content` field to a string. The Anthropic SDK may
 * deliver it as a plain string or as an array of content blocks
 * (`[{ type: 'text', text: '…' }, …]`). Image / non-text blocks are rendered
 * as a placeholder so callers always see a non-empty string when there is
 * any payload at all.
 */
export function normalizeToolResultContent(content: ToolResultContent): string {
  if (isString(content)) return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (isString(b)) return b;
        if (isContentBlock(b)) {
          if (isString(b.text)) return b.text;
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
export function serializeToolInput(toolName: string, input: ToolInput): string | undefined {
  if (!isObject(input)) return undefined;
  if (toolName === 'Bash' && 'command' in input && isString(input.command)) {
    return input.command;
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
