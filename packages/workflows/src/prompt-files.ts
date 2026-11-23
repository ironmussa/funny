/**
 * `prompt_file:` resolution. A flow's agent step may keep its prompt in a file
 * next to the flow; the host reads those files (from wherever it read the flow)
 * and this module puts their text in place of each `prompt_file`, so the
 * compiler only ever sees `prompt`. A host that does not call it gets a compile
 * error for an unresolved `prompt_file`, never an empty prompt.
 */

import type { ParsedNode, ParsedWorkflow } from './schema.js';

type SpawnAgent = NonNullable<ParsedNode['spawn_agent']>;

/** Reads a prompt file by its path relative to the flow's directory: its text, or null when missing. */
export type PromptFileReader = (path: string) => Promise<string | null>;

/** Why a step's prompt file could not be used. */
export interface PromptFileProblem {
  /** `<node>`, `<node>.before_retry` or `<node>.on_reject`. */
  step: string;
  field: 'prompt_file';
  message: string;
}

export type PromptFilesResult =
  | { ok: true; workflow: ParsedWorkflow }
  | { ok: false; problems: PromptFileProblem[] };

/**
 * The path of a prompt file relative to the flow's directory, or why it is
 * refused: absolute paths, `..` segments and backslashes could reach outside
 * the directory the flow was read from.
 */
export function normalizePromptPath(path: string): { path: string } | { error: string } {
  const raw = path.trim();
  if (raw === '') return { error: 'is empty' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw))
    return { error: 'must be relative to the flow' };
  if (raw.includes('\\')) return { error: 'must use / as the separator' };
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    return { error: 'must stay inside the flow directory (no ..)' };
  }
  if (segments.length === 0) return { error: 'is empty' };
  return { path: segments.join('/') };
}

/** Every agent step of the flow with its step id, in declaration order. */
function agentSteps(parsed: ParsedWorkflow): Array<{ step: string; action: SpawnAgent }> {
  const steps: Array<{ step: string; action: SpawnAgent }> = [];
  for (const node of parsed.nodes) {
    if (node.spawn_agent) steps.push({ step: node.id, action: node.spawn_agent });
    if (node.retry?.before_retry) {
      steps.push({ step: `${node.id}.before_retry`, action: node.retry.before_retry });
    }
    if (node.approval?.on_reject) {
      steps.push({ step: `${node.id}.on_reject`, action: node.approval.on_reject });
    }
  }
  return steps;
}

/** The step with its prompt file's text as its prompt (`prompt_file` dropped). */
function withPrompt(action: SpawnAgent, prompt: string): SpawnAgent {
  const { prompt_file: _resolved, ...rest } = action;
  return { ...rest, prompt };
}

/**
 * The flow with every `prompt_file` replaced by the file's text, read once per
 * path. Every problem is reported at once, so a flow author sees them all.
 */
export async function resolvePromptFiles(
  parsed: ParsedWorkflow,
  readFile: PromptFileReader,
): Promise<PromptFilesResult> {
  const problems: PromptFileProblem[] = [];
  const texts = new Map<string, string | null>();
  const resolved = new Map<SpawnAgent, string>();

  for (const { step, action } of agentSteps(parsed)) {
    if (action.prompt_file === undefined) continue;
    const normalized = normalizePromptPath(action.prompt_file);
    if ('error' in normalized) {
      problems.push({
        step,
        field: 'prompt_file',
        message: `prompt_file "${action.prompt_file}" ${normalized.error}`,
      });
      continue;
    }
    if (!texts.has(normalized.path)) texts.set(normalized.path, await readFile(normalized.path));
    const text = texts.get(normalized.path);
    if (text === null || text === undefined) {
      problems.push({
        step,
        field: 'prompt_file',
        message: `prompt_file "${normalized.path}" was not found next to the flow`,
      });
      continue;
    }
    resolved.set(action, text);
  }
  if (problems.length > 0) return { ok: false, problems };
  if (resolved.size === 0) return { ok: true, workflow: parsed };

  const swap = (action: SpawnAgent): SpawnAgent => {
    const text = resolved.get(action);
    return text === undefined ? action : withPrompt(action, text);
  };
  const nodes = parsed.nodes.map((node) => {
    const next: ParsedNode = { ...node };
    if (node.spawn_agent) next.spawn_agent = swap(node.spawn_agent);
    if (node.retry?.before_retry) {
      next.retry = { ...node.retry, before_retry: swap(node.retry.before_retry) };
    }
    if (node.approval?.on_reject) {
      next.approval = { ...node.approval, on_reject: swap(node.approval.on_reject) };
    }
    return next;
  });
  return { ok: true, workflow: { ...parsed, nodes } };
}
