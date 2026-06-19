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
      (typeof e.title === 'string' && e.title) ||
      (typeof e.description === 'string' && e.description) ||
      '';
    if (!content) continue;
    const status =
      e.status === 'completed' || e.status === 'in_progress'
        ? e.status
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

export function getSummary(
  name: string,
  parsed: Record<string, unknown>,
  t: (key: string) => string,
): string | null {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return (parsed.file_path as string) ?? null;
    case 'Bash':
      return (parsed.command as string) ?? null;
    case 'Glob':
      return (parsed.pattern as string) ?? null;
    case 'Grep':
      return (parsed.pattern as string) ?? null;
    case 'Task':
    case 'Agent':
      return (parsed.description as string) ?? null;
    case 'WebSearch':
      return (parsed.query as string) ?? null;
    case 'WebFetch':
      return (parsed.url as string) ?? null;
    case 'NotebookEdit':
      return (parsed.notebook_path as string) ?? null;
    case 'TodoWrite':
    case 'updateTodos':
    case 'todo_write': {
      const todos = getTodos(parsed);
      if (!todos) return null;
      const done = todos.filter((tc) => tc.status === 'completed').length;
      return `${done}/${todos.length} ${t('tools.done')}`;
    }
    case 'AskUserQuestion': {
      const questions = getQuestions(parsed);
      if (!questions) return null;
      return `${questions.length} ${questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}`;
    }
    case 'Think': {
      const thought = (parsed.content as string) ?? (parsed.description as string) ?? '';
      const firstLine = thought
        .split('\n')
        .find((l) => l.trim())
        ?.trim();
      return firstLine ? (firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine) : null;
    }
    case 'ProviderError':
      return (parsed.error as string) ?? null;
    case 'Background':
      return (
        (parsed.label as string) ??
        (parsed.command as string) ??
        (parsed.jobId ? `job ${String(parsed.jobId)}` : null)
      );
    default:
      // For Gemini ACP tool calls, the description field contains the
      // human-readable title from the ACP protocol (e.g. file path or search query)
      return (parsed.description as string) ?? null;
  }
}

export function getToolLabel(name: string, t: (key: string) => string): string {
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
  };
  return labels[name] ?? name;
}

export {
  toEditorUri,
  toEditorUriWithLine,
  hasEditorUri,
  openFileInEditor,
  openFileInInternalEditor,
  getEditorLabel,
} from '@/lib/editor-utils';

export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath;
}
