/**
 * Types and pure helpers of `GenericACPProcess` (`generic-acp.ts`): the ACP SDK
 * type aliases it reads, tool-input and plan rendering helpers, banner
 * stripping and message shaping. Kept apart so the process class holds only
 * the lifecycle and the update translation.
 */

import { randomUUID } from 'crypto';

import type { JsonObject } from '@funny/shared/json';

import {
  buildTodoWriteInputFromRaw,
  enrichTodoWriteInputFromOutput,
  hasRenderableTodoInput,
  type ACPToolResultData,
  type TodoWriteInput,
} from './acp-tool-input.js';
import type { ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed). `/unstable` keeps the
// full v1 surface the 1.x default import exposed (prompt `usage`, `usage_update`,
// session config options); the wire protocol is still ACP v1.
export type ACPSDK = typeof import('@agentclientprotocol/sdk/unstable');
export type ACPSessionUpdate = import('@agentclientprotocol/sdk/unstable').SessionUpdate;
export type ACPRequestPermissionRequest =
  import('@agentclientprotocol/sdk/unstable').RequestPermissionRequest;
export type ACPRequestPermissionResponse =
  import('@agentclientprotocol/sdk/unstable').RequestPermissionResponse;
export type ACPConnection = import('@agentclientprotocol/sdk/unstable').ClientConnection;
export type ACPPromptRequest = import('@agentclientprotocol/sdk/unstable').PromptRequest;
type ACPSessionConfigOption = import('@agentclientprotocol/sdk/unstable').SessionConfigOption;
type ACPSessionConfigSelectOptions =
  import('@agentclientprotocol/sdk/unstable').SessionConfigSelectOptions;
type ACPToolCallStatus = import('@agentclientprotocol/sdk/unstable').ToolCallStatus;
/** `configOptions` of a newSession / loadSession response. */
export type ACPSessionConfigOptions = readonly ACPSessionConfigOption[] | null | undefined;
/** Context for calling agent-side ACP methods on a live connection. */
export type ACPAgentContext = ACPConnection['agent'];
export type ACPMethods = ACPSDK['methods'];

export type ACPUpdateOf<K extends ACPSessionUpdate['sessionUpdate']> = Extract<
  ACPSessionUpdate,
  { sessionUpdate: K }
>;
export type ACPContentBlock = ACPUpdateOf<'agent_message_chunk'>['content'];
export type ACPToolCallUpdateLike = ACPUpdateOf<'tool_call'> | ACPUpdateOf<'tool_call_update'>;
export type ACPPlanUpdate = ACPUpdateOf<'plan'>;

/** The ACP fields `buildACPToolInput` / `inferACPToolName` read from a tool call event. */
export interface ACPToolCallFields {
  kind: string | undefined;
  title: string;
  rawInput: unknown;
  locations: Array<{ path: string; line?: number | null }> | undefined;
  content: unknown[] | undefined;
}

/** What a model-selection fallback logs besides the requested model. */
export interface ModelFallbackDetail {
  available?: string[];
  error?: string;
}

/**
 * A plan entry as `planRender: 'text'` reads it: ACP's `content`, or the
 * `title` / `description` some providers send instead.
 */
export interface PlanTextEntry {
  status?: string;
  content?: string;
  title?: string;
  description?: string;
}

export function readToolCallFields(update: ACPToolCallUpdateLike): ACPToolCallFields {
  // SAFETY: both `tool_call` and `tool_call_update` carry optional `kind`, `rawInput`,
  // `locations` and `content`; they are read untyped here so an older or looser
  // provider payload passes through unchanged, and every consumer reads them optionally.
  const u = update as any;
  // SAFETY: same invariant as above; the casts only name the ACP field types.
  return {
    kind: u.kind as string | undefined,
    title: update.title || '',
    rawInput: u.rawInput,
    locations: u.locations as ACPToolCallFields['locations'],
    content: u.content as unknown[] | undefined,
  };
}

export function isTerminalToolStatus(status: ACPToolCallStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

/** TodoWrite: pull todos from the tool output when missing and normalize to `{ todos }`. */
export function finalizeTodoInput(
  toolName: string,
  input: JsonObject,
  result: Pick<ACPToolResultData, 'rawOutput'>,
): JsonObject {
  if (toolName !== 'TodoWrite') return input;
  const enriched = enrichTodoWriteInputFromOutput(input, result);
  const clean = buildTodoWriteInputFromRaw(enriched);
  return clean ? { todos: clean.todos } : enriched;
}

/** Plan entry status → markdown checkbox (completed → [x], in_progress → [~], else [ ]). */
function planStatusMark(status: string | undefined): string {
  if (status === 'completed') return '[x]';
  if (status === 'in_progress') return '[~]';
  return '[ ]';
}

/** Render `[status, text]` pairs as a numbered checklist, one entry per line. */
export function formatPlanChecklist(items: Array<[string | undefined, unknown]>): string {
  return items.map(([status, text], i) => `${planStatusMark(status)} ${i + 1}. ${text}`).join('\n');
}

/**
 * Whether a built tool input has the primary field its client card needs to
 * render a meaningful summary. Used by `deferUnrenderableToolInput` providers.
 */
export function isRenderableToolInput(toolName: string, input: JsonObject): boolean {
  const has = (key: string) => {
    const value = input[key];
    return isString(value) && value.length > 0;
  };
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return has('file_path');
    case 'Bash':
      return has('command');
    case 'Glob':
    case 'Grep':
      return has('pattern');
    case 'TodoWrite':
      return hasRenderableTodoInput(input);
    default:
      return true;
  }
}

/**
 * Merge a buffered tool input with a freshly built one, preferring non-empty
 * values from `next` (e.g. a file_path the initial deferred event was missing).
 */
export function mergeToolInput(prev: JsonObject, next: JsonObject): JsonObject {
  const merged = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Match the serialization Claude SDK uses for permission-rule lookup so a single
 * rule (e.g. "Bash: git status") behaves the same regardless of provider.
 */
export function serializeToolInputForRule(
  toolName: string,
  toolInput: JsonObject | undefined,
): string | undefined {
  if (!toolInput || !isObject(toolInput)) return undefined;
  if (toolName === 'Bash' && isString(toolInput.command)) {
    return toolInput.command;
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return undefined;
  }
}

/**
 * Max prefix length the banner regex is applied to. The banner always sits at
 * the very start (the source is also length-capped at validation), so bounding
 * the regex input to a fixed head is behavior-preserving for real banners while
 * preventing catastrophic backtracking (ReDoS) from running against an
 * arbitrarily long message body — the runtime half of the §1.3 guard.
 */
const BANNER_SCAN_LIMIT = 8192;

/** Strip a provider banner (manifest regex-as-data) from the start of text. */
export function stripBanner(text: string, regexSource: string): string {
  try {
    const re = new RegExp(regexSource);
    if (text.length <= BANNER_SCAN_LIMIT) return text.replace(re, '').replace(/^\s+/, '');
    const head = text.slice(0, BANNER_SCAN_LIMIT).replace(re, '').replace(/^\s+/, '');
    return head + text.slice(BANNER_SCAN_LIMIT);
  } catch {
    return text;
  }
}

/** An assistant message with one `tool_use` block, under a fresh message id. */
export function toolUseMessage(
  toolCallId: string,
  name: string,
  input: JsonObject | TodoWriteInput,
): CLIMessage {
  return {
    type: 'assistant',
    message: {
      id: randomUUID(),
      content: [{ type: 'tool_use', id: toolCallId, name, input }],
    },
  };
}

/** A user message with one `tool_result` block for `toolCallId`. */
export function toolResultMessage(toolCallId: string, content: string): CLIMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolCallId, content }],
    },
  };
}

export function stopReasonToSubtype(stopReason: string | undefined): ResultSubtype {
  if (stopReason === 'cancelled') return 'error_during_execution';
  if (stopReason === 'max_tokens') return 'error_max_turns';
  return 'success';
}

/** A select config option's id and the set of its selectable value ids. */
export interface SelectConfigOption {
  configId: string;
  valueIds: Set<string>;
}

/**
 * Find the first select config option of `category` in a newSession response.
 * Flattens grouped option lists and records the configId + selectable value
 * ids; null when the agent does not advertise such an option.
 */
export function findSelectConfigOption(
  configOptions: ACPSessionConfigOptions,
  category: string,
): SelectConfigOption | null {
  if (!Array.isArray(configOptions)) return null;
  for (const o of configOptions) {
    if (!o || o.category !== category || o.type !== 'select') continue;
    return { configId: String(o.id), valueIds: collectSelectValueIds(o.options) };
  }
  return null;
}

function collectSelectValueIds(options: ACPSessionConfigSelectOptions | undefined): Set<string> {
  const valueIds = new Set<string>();
  const collect = (entries: ACPSessionConfigSelectOptions | undefined): void => {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || !isObject(e)) continue;
      // A select option carries `value`; a group carries its own `options`.
      if ('value' in e && isString(e.value)) valueIds.add(e.value);
      if ('options' in e && Array.isArray(e.options)) collect(e.options);
    }
  };
  collect(options);
  return valueIds;
}

function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

/** `typeof value === 'object'` without null; keeps `any` as `any`. */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}
