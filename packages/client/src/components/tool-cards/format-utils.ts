import { mcpToolTitle, parseMcpToolName } from './mcp-tool';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Cursor ACP `updateTodos` / `todo_write` and Claude `TodoWrite` share the checklist card. */
export function isTodoToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, '');
  return n === 'todowrite' || n === 'updatetodos' || n === 'towrite';
}

function normalizeTodoItems(arr: unknown[]): TodoItem[] | null {
  const todos: TodoItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const content =
      (typeof e.content === 'string' && e.content) ||
      // Codex SDK todo_list items use `{ text, completed }`, unlike the
      // `{ content, status }` shape used by Claude and ACP providers.
      (typeof e.text === 'string' && e.text) ||
      (typeof e.title === 'string' && e.title) ||
      (typeof e.description === 'string' && e.description) ||
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
      ...(typeof e.activeForm === 'string' ? { activeForm: e.activeForm } : {}),
    });
  }
  return todos.length > 0 ? todos : null;
}

export function formatInput(
  input: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return { value: input };
    }
  }
  return input;
}

export function getTodos(parsed: Record<string, unknown>): TodoItem[] | null {
  for (const key of ['todos', 'entries', 'items'] as const) {
    const arr = parsed[key];
    if (Array.isArray(arr)) {
      const normalized = normalizeTodoItems(arr);
      if (normalized) return normalized;
    }
  }
  const outcome = parsed.outcome;
  if (outcome && typeof outcome === 'object') {
    const o = outcome as Record<string, unknown>;
    if (Array.isArray(o.todos)) {
      const normalized = normalizeTodoItems(o.todos);
      if (normalized) return normalized;
    }
  }
  return null;
}

export function getFilePath(name: string, parsed: Record<string, unknown>): string | null {
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    return (parsed.file_path as string) ?? null;
  }
  return null;
}

export function getQuestions(parsed: Record<string, unknown>): Question[] | null {
  const questions = parsed.questions;
  if (!Array.isArray(questions)) return null;
  return questions as Question[];
}

type SummaryFn = (parsed: Record<string, unknown>, t: (key: string) => string) => string | null;

/** Summary that is just one input field (or null). */
const field =
  (key: string): SummaryFn =>
  (parsed) =>
    (parsed[key] as string) ?? null;

function todoSummary(parsed: Record<string, unknown>, t: (key: string) => string): string | null {
  const todos = getTodos(parsed);
  if (!todos) return null;
  const done = todos.filter((tc) => tc.status === 'completed').length;
  return `${done}/${todos.length} ${t('tools.done')}`;
}

function questionSummary(
  parsed: Record<string, unknown>,
  t: (key: string) => string,
): string | null {
  const questions = getQuestions(parsed);
  if (!questions) return null;
  return `${questions.length} ${questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}`;
}

function thinkSummary(parsed: Record<string, unknown>): string | null {
  const thought = (parsed.content as string) ?? (parsed.description as string) ?? '';
  const firstLine = thought
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (!firstLine) return null;
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

function taskUpdateSummary(parsed: Record<string, unknown>): string | null {
  if (!parsed.taskId) return null;
  const status = parsed.status ? ` → ${String(parsed.status)}` : '';
  return `#${String(parsed.taskId)}${status}`;
}

function backgroundSummary(parsed: Record<string, unknown>): string | null {
  return (
    (parsed.label as string) ??
    (parsed.command as string) ??
    (parsed.jobId ? `job ${String(parsed.jobId)}` : null)
  );
}

const filePathSummary = field('file_path');

const SUMMARIES: Record<string, SummaryFn> = {
  Read: filePathSummary,
  Write: filePathSummary,
  Edit: filePathSummary,
  Bash: (parsed) =>
    typeof parsed.command === 'string'
      ? unwrapShellCommand(parsed.command)
      : ((parsed.command as string) ?? null),
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
    typeof parsed.query === 'string'
      ? parsed.query.replace(/^select:/, '').replace(/,/g, ', ')
      : null,
  Skill: field('skill'),
  TaskCreate: field('subject'),
  TaskUpdate: taskUpdateSummary,
  TaskOutput: (parsed) => (parsed.task_id ? String(parsed.task_id) : null),
  TaskStop: (parsed) => (parsed.task_id ? String(parsed.task_id) : null),
  ScheduleWakeup: field('reason'),
  Monitor: (parsed) => (parsed.description as string) ?? (parsed.command as string) ?? null,
  SendMessage: (parsed) => (parsed.summary as string) ?? (parsed.to as string) ?? null,
  apply_patch: (parsed) => patchSummary(parsed),
  ApplyPatch: (parsed) => patchSummary(parsed),
  update_plan: (parsed) =>
    typeof parsed.explanation === 'string'
      ? (parsed.explanation.split('\n').find((l) => l.trim()) ?? null)
      : null,
  Tool: (parsed) =>
    parsed.server && parsed.tool
      ? `${String(parsed.server)} · ${String(parsed.tool)}`
      : ((parsed.description as string) ?? null),
  Background: backgroundSummary,
};

// For Gemini ACP tool calls, the description field contains the
// human-readable title from the ACP protocol (e.g. file path or search query)
const defaultSummary = field('description');

export function getSummary(
  name: string,
  parsed: Record<string, unknown>,
  t: (key: string) => string,
): string | null {
  const summarize = Object.hasOwn(SUMMARIES, name) ? SUMMARIES[name] : defaultSummary;
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
function patchSummary(parsed: Record<string, unknown>): string | null {
  const paths: string[] = [];
  if (typeof parsed.input === 'string') {
    for (const m of parsed.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      paths.push(m[1].trim());
    }
  }
  if (Array.isArray(parsed.changes)) {
    for (const change of parsed.changes) {
      if (change && typeof change.path === 'string') paths.push(change.path);
    }
  }
  if (paths.length === 0) return null;
  return paths.length > 1 ? `${paths[0]} +${paths.length - 1}` : paths[0];
}

export function getToolLabel(name: string, t: (key: string) => string): string {
  const mcp = parseMcpToolName(name);
  if (mcp) return mcpToolTitle(mcp, t);
  const labels: Record<string, string> = {
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
  };
  return labels[name] ?? name;
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
