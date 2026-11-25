import { isJsonObject, type JsonObject, type JsonValue } from '@funny/shared/json';

import { mcpToolTitle, parseMcpToolName } from './mcp-tool';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// Type aliases, not interfaces: they come from a tool call's JSON input, and an
// alias stays comparable with `JsonValue` (an interface has no index signature).
export type QuestionOption = {
  label: string;
  description: string;
};

export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

/** Cursor ACP `updateTodos` / `todo_write` and Claude `TodoWrite` share the checklist card. */
export function isTodoToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, '');
  return n === 'todowrite' || n === 'updatetodos' || n === 'towrite';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function normalizeTodoItems(arr: JsonValue[]): TodoItem[] | null {
  const todos: TodoItem[] = [];
  for (const e of arr) {
    if (!isJsonObject(e)) continue;
    const content =
      (isString(e.content) && e.content) ||
      // Codex SDK todo_list items use `{ text, completed }`, unlike the
      // `{ content, status }` shape used by Claude and ACP providers.
      (isString(e.text) && e.text) ||
      (isString(e.title) && e.title) ||
      (isString(e.description) && e.description) ||
      '';
    if (!content) continue;
    const status =
      e.status === 'completed' || e.status === 'in_progress'
        ? e.status
        : e.completed === true
          ? 'completed'
          : e.status === 'cancelled'
            ? 'completed'
            : 'pending';
    todos.push({
      content,
      status,
      activeForm: isString(e.activeForm) ? e.activeForm : undefined,
    });
  }
  return todos.length > 0 ? todos : null;
}

/** Tool input arrives either as JSON text or already parsed. */
function isInputText(input: string | JsonObject): input is string {
  return typeof input === 'string';
}

/** A tool input that is not JSON, kept as its text. */
type UnparsedToolInput = { value: string };

function unparsedToolInput(text: string): UnparsedToolInput {
  return { value: text };
}

export function formatInput(input: string | JsonObject | null | undefined): JsonObject {
  if (!input) return {};
  if (isInputText(input)) {
    try {
      return JSON.parse(input);
    } catch {
      return unparsedToolInput(input);
    }
  }
  return input;
}

export function getTodos(parsed: JsonObject): TodoItem[] | null {
  for (const key of ['todos', 'entries', 'items'] as const) {
    const arr = parsed[key];
    if (Array.isArray(arr)) {
      const normalized = normalizeTodoItems(arr);
      if (normalized) return normalized;
    }
  }
  const outcome = parsed.outcome;
  if (isJsonObject(outcome)) {
    const o = outcome;
    if (Array.isArray(o.todos)) {
      const normalized = normalizeTodoItems(o.todos);
      if (normalized) return normalized;
    }
  }
  return null;
}

export function getFilePath(name: string, parsed: JsonObject): string | null {
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    // SAFETY: Read, Write and Edit declare file_path as a string in their input schema.
    return (parsed.file_path as string) ?? null;
  }
  return null;
}

export function getQuestions(parsed: JsonObject): Question[] | null {
  const questions = parsed.questions;
  if (!Array.isArray(questions)) return null;
  // SAFETY: AskUserQuestion's input schema declares questions as an array of
  // { question, header, options, multiSelect }, the Question shape.
  return questions as Question[];
}

type SummaryFn = (parsed: JsonObject, t: (key: string) => string) => string | null;

/** Summary that is just one input field (or null). */
// SAFETY: every key passed to field() below is declared as a string in that
// tool's input schema; a missing key is undefined, which `??` turns into null.
const field =
  (key: string): SummaryFn =>
  (parsed) =>
    (parsed[key] as string) ?? null;

function todoSummary(parsed: JsonObject, t: (key: string) => string): string | null {
  const todos = getTodos(parsed);
  if (!todos) return null;
  const done = todos.filter((tc) => tc.status === 'completed').length;
  return `${done}/${todos.length} ${t('tools.done')}`;
}

function questionSummary(parsed: JsonObject, t: (key: string) => string): string | null {
  const questions = getQuestions(parsed);
  if (!questions) return null;
  return `${questions.length} ${questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}`;
}

function thinkSummary(parsed: JsonObject): string | null {
  // SAFETY: Think inputs carry their text in content or description, both strings.
  const thought = (parsed.content as string) ?? (parsed.description as string) ?? '';
  const firstLine = thought
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (!firstLine) return null;
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

function taskUpdateSummary(parsed: JsonObject): string | null {
  if (!parsed.taskId) return null;
  const status = parsed.status ? ` → ${String(parsed.status)}` : '';
  return `#${String(parsed.taskId)}${status}`;
}

function backgroundSummary(parsed: JsonObject): string | null {
  // SAFETY: Background tool inputs declare label and command as strings.
  return (
    (parsed.label as string) ??
    (parsed.command as string) ??
    (parsed.jobId ? `job ${String(parsed.jobId)}` : null)
  );
}

const filePathSummary = field('file_path');

const SUMMARIES = new Map<string, SummaryFn>(
  Object.entries({
    Read: filePathSummary,
    Write: filePathSummary,
    Edit: filePathSummary,
    Bash: (parsed, t) =>
      isString(parsed.command) ? unwrapShellCommand(parsed.command) : field('command')(parsed, t),
    Glob: field('pattern'),
    Grep: field('pattern'),
    Task: field('description'),
    Agent: field('description'),
    WebSearch: field('query'),
    WebFetch: field('url'),
    NotebookEdit: field('notebook_path'),
    TodoWrite: todoSummary,
    updateTodos: todoSummary,
    todo_write: todoSummary,
    AskUserQuestion: questionSummary,
    Think: thinkSummary,
    ProviderError: field('error'),
    ToolSearch: (parsed) =>
      isString(parsed.query) ? parsed.query.replace(/^select:/, '').replace(/,/g, ', ') : null,
    Skill: field('skill'),
    TaskCreate: field('subject'),
    TaskUpdate: taskUpdateSummary,
    TaskOutput: (parsed) => (parsed.task_id ? String(parsed.task_id) : null),
    TaskStop: (parsed) => (parsed.task_id ? String(parsed.task_id) : null),
    ScheduleWakeup: field('reason'),
    // SAFETY: Monitor declares description and command as strings in its input schema.
    Monitor: (parsed) => (parsed.description as string) ?? (parsed.command as string) ?? null,
    // SAFETY: SendMessage declares summary and to as strings in its input schema.
    SendMessage: (parsed) => (parsed.summary as string) ?? (parsed.to as string) ?? null,
    apply_patch: (parsed) => patchSummary(parsed),
    ApplyPatch: (parsed) => patchSummary(parsed),
    update_plan: (parsed) =>
      isString(parsed.explanation)
        ? (parsed.explanation.split('\n').find((l) => l.trim()) ?? null)
        : null,
    // SAFETY: a generic Tool input gets description from the ACP tool title, a
    // string (core/agents/acp-tool-input.ts).
    Tool: (parsed) =>
      parsed.server && parsed.tool
        ? `${String(parsed.server)} · ${String(parsed.tool)}`
        : ((parsed.description as string) ?? null),
    Background: backgroundSummary,
  } satisfies Record<string, SummaryFn>),
);

// For Gemini ACP tool calls, the description field contains the
// human-readable title from the ACP protocol (e.g. file path or search query)
const defaultSummary = field('description');

export function getSummary(
  name: string,
  parsed: JsonObject,
  t: (key: string) => string,
): string | null {
  const summarize = SUMMARIES.get(name) ?? defaultSummary;
  return summarize(parsed, t);
}

const SHELL_WRAPPER = /^(?:\/usr)?(?:\/bin\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/;

/**
 * The command inside a shell wrapper (`/bin/bash -lc '…'`, as Codex sends
 * them), unescaped; anything else is returned as is.
 */
export function unwrapShellCommand(command: string): string {
  const match = command.trim().match(SHELL_WRAPPER);
  if (!match) return command;
  const [, quote, body] = match;
  return quote === "'" ? body.replace(/'\\''/g, "'") : body.replace(/\\(["\\$`])/g, '$1');
}

/** The file(s) a patch touches: the first path, plus how many more. */
function patchSummary(parsed: JsonObject): string | null {
  const paths: string[] = [];
  if (isString(parsed.input)) {
    for (const m of parsed.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      paths.push(m[1].trim());
    }
  }
  if (Array.isArray(parsed.changes)) {
    for (const change of parsed.changes) {
      if (isJsonObject(change) && isString(change.path)) paths.push(change.path);
    }
  }
  if (paths.length === 0) return null;
  return paths.length > 1 ? `${paths[0]} +${paths.length - 1}` : paths[0];
}

export function getToolLabel(name: string, t: (key: string) => string): string {
  const mcp = parseMcpToolName(name);
  if (mcp) return mcpToolTitle(mcp, t);
  const labels = new Map<string, string>(
    Object.entries({
      Read: t('tools.readFile'),
      Write: t('tools.writeFile'),
      Edit: t('tools.editFile'),
      Bash: t('tools.runCommand'),
      Glob: t('tools.findFiles'),
      Grep: t('tools.searchCode'),
      WebFetch: t('tools.fetchUrl'),
      WebSearch: t('tools.webSearch'),
      Task: t('tools.subagent'),
      Agent: t('tools.subagent'),
      TodoWrite: t('tools.todos'),
      updateTodos: t('tools.todos'),
      todo_write: t('tools.todos'),
      NotebookEdit: t('tools.editNotebook'),
      AskUserQuestion: t('tools.question'),
      Think: t('tools.thinking'),
      ProviderError: t('tools.providerError'),
      Background: t('tools.background'),
      Tool: t('tools.tool'),
      ToolSearch: t('tools.loadTools'),
      Skill: t('tools.skill'),
      TaskCreate: t('tools.newTask'),
      TaskUpdate: t('tools.updateTask'),
      TaskOutput: t('tools.taskOutput'),
      TaskStop: t('tools.stopTask'),
      ScheduleWakeup: t('tools.scheduleWakeup'),
      Monitor: t('tools.monitor'),
      SendMessage: t('tools.sendMessage'),
      apply_patch: t('tools.applyPatch'),
      ApplyPatch: t('tools.applyPatch'),
      update_plan: t('tools.updatePlan'),
      EnterPlanMode: t('tools.planMode'),
    } satisfies Record<string, string>),
  );
  return labels.get(name) ?? name;
}

export { toEditorUri, openFileInEditor, getEditorLabel } from '@/lib/editor-utils';

export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath;
}

/**
 * True when `filePath` is `basePath` itself or a descendant of it. Used to
 * skip `/files/read` calls the runtime would reject with 403 (paths outside
 * the thread's project/worktree, e.g. `/tmp` scripts or Claude memory files).
 */
export function isPathWithin(filePath: string, basePath: string): boolean {
  const file = filePath.replace(/\\/g, '/');
  const base = basePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!base) return false;
  return file === base || file.startsWith(base + '/');
}
