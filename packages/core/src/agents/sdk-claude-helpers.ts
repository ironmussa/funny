/**
 * Pure helpers of `SDKClaudeProcess` (`sdk-claude.ts`): input guards, the
 * sensitive-path check of the PreToolUse hook, background-task bookkeeping
 * predicates and result-message shaping. Kept apart so the process class file
 * holds only the query lifecycle.
 */

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

import type { CLIMessage } from './types.js';

const SENSITIVE_PATH_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read']);
const SENSITIVE_PATH_PATTERNS = [/(?:^|[^A-Za-z0-9_])\.claude(?:[/\s'"`]|$)/, /\.config\/claude/];

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** The fields of a tool call's input that name what it touches; each is checked before use. */
interface ToolPathFields {
  command?: unknown;
  file_path?: unknown;
  notebook_path?: unknown;
}

/** A tool call's input: any non-null object, read only for the fields below. */
export function isToolInput(value: unknown): value is ToolPathFields {
  return typeof value === 'object' && value !== null;
}

/** The effort levels the Claude SDK accepts. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set<EffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.has(value);
}

/** Any object, null included (`Object.assign` skips a null source). */
export function isObjectOrNull(value: unknown): value is object | null {
  return typeof value === 'object';
}

/** The paths (or Bash command) a tool call touches. */
function pathTargets(tool: string, ti: any): string[] {
  if (!isToolInput(ti)) return [];
  if (tool === 'Bash' && isString(ti.command)) return [ti.command];
  const out: string[] = [];
  if (isString(ti.file_path)) out.push(ti.file_path);
  if (isString(ti.notebook_path)) out.push(ti.notebook_path);
  return out;
}

/** Whether a tool call touches Claude's own config (`.claude`, `.config/claude`). */
export function touchesSensitivePath(
  toolName: string,
  toolInput: ToolPathFields | undefined,
): boolean {
  if (!SENSITIVE_PATH_TOOLS.has(toolName)) return false;
  return pathTargets(toolName, toolInput).some((target) =>
    SENSITIVE_PATH_PATTERNS.some((rx) => rx.test(target)),
  );
}

export function isSessionIdle(msg: any): boolean {
  return msg.subtype === 'session_state_changed' && msg.state === 'idle';
}

/** Ambient tasks (live-update watchers) never end on their own, so they are not tracked. */
export function activeBackgroundTaskIds(tasks: any[] | undefined): Set<string> {
  return new Set((tasks ?? []).filter((t) => !t.ambient).map((t) => t.task_id));
}

export function isBackgroundTaskStart(msg: any): boolean {
  return Boolean(msg.is_backgrounded) && !msg.ambient;
}

export function isTerminalTaskStatus(status: string | undefined): boolean {
  return !!status && status !== 'pending' && status !== 'running' && status !== 'paused';
}

/** `promise`'s value, or null once `ms` passes. The promise must not reject. */
export async function nullAfter<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type ResultMessage = Extract<CLIMessage, { type: 'result' }>;

export function toResultMessage(r: any): ResultMessage {
  return {
    type: 'result',
    subtype: r.subtype,
    is_error: r.is_error,
    duration_ms: r.duration_ms,
    num_turns: r.num_turns,
    result: r.result,
    total_cost_usd: r.total_cost_usd,
    session_id: r.session_id,
    errors: r.errors,
  };
}

export function isEmptySuccessResult(msg: any): boolean {
  return msg.type === 'result' && msg.subtype === 'success' && !msg.is_error && !msg.num_turns;
}

/** A message that shows the resumed session went on to a turn of its own. */
export function continuesSession(msg: any): boolean {
  return (
    msg.type === 'assistant' ||
    msg.type === 'result' ||
    (msg.type === 'system' && msg.subtype === 'init')
  );
}
