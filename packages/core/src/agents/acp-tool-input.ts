/**
 * ACP Tool Input Builder — constructs canonical tool inputs from ACP protocol data.
 *
 * The ACP protocol provides: kind (category enum), title (human-readable),
 * locations (file paths), and rawInput (opaque provider data).
 * The client UI expects specific field names per tool type (file_path, command, pattern, etc.).
 * These functions bridge that gap with clear, deterministic logic.
 *
 * Used by both GeminiACPProcess and DeepAgentProcess — any ACP-based provider
 * can use these to emit correctly-formatted tool call data.
 */

/** ACP tool call event data available when building the input. */
export interface ACPToolCallData {
  kind?: string; // ACP ToolKind: "read" | "edit" | "search" | "execute" | etc.
  title: string; // Human-readable description from ACP
  rawInput?: unknown; // Opaque input from the provider (often empty)
  locations?: Array<{ path: string; line?: number | null }>; // File paths
  content?: unknown[]; // ACP ToolCallContent blocks (resource / resource_link can carry a file path)
}

/**
 * Map ACP kind + title to a canonical tool name for the client UI.
 *
 * The `overrides` parameter handles provider-specific differences:
 * - Gemini maps `think` → `'Task'` (default)
 * - DeepAgent maps `think` → `'Think'` (via `{ thinkToolName: 'Think' }`)
 */
/** Cursor ACP / provider todo tool names → canonical `TodoWrite` for the UI. */
const TODO_TOOL_ALIASES = new Set(['todowrite', 'updatetodos', 'todo_write', 'towrite']);

function isTodoToolName(name: string): boolean {
  return TODO_TOOL_ALIASES.has(name.toLowerCase().replace(/[_-]/g, ''));
}

function inferTodoToolFromRawInput(rawInput: unknown): boolean {
  if (rawInput == null || typeof rawInput !== 'object') return false;
  const raw = rawInput as Record<string, unknown>;
  const rawName = raw._toolName ?? raw._TOOLNAME ?? raw.toolName ?? raw.tool_name ?? raw.toolname;
  return typeof rawName === 'string' && isTodoToolName(rawName);
}

export function inferACPToolName(
  kind: string | undefined,
  title: string,
  overrides?: { thinkToolName?: string },
  rawInput?: unknown,
): string {
  const thinkName = overrides?.thinkToolName ?? 'Task';

  if (inferTodoToolFromRawInput(rawInput)) return 'TodoWrite';

  switch (kind) {
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'delete':
      return 'Edit';
    case 'search':
      if (title.includes(' in ') || /\bin\b.*within/.test(title)) return 'Grep';
      if (title.includes('*') || title.includes('?')) return 'Glob';
      return 'Grep';
    case 'execute':
      return 'Bash';
    case 'fetch':
      return 'WebFetch';
    case 'think':
      return thinkName;
    case 'move':
      return 'Bash';
    case 'switch_mode':
      return 'Task';
  }

  // Title-based heuristics (for providers that lack kind or use generic kinds)
  const titleLower = title.toLowerCase();
  if (titleLower.includes('read_file') || titleLower.includes('read file')) return 'Read';
  if (titleLower.includes('write_file') || titleLower.includes('write file')) return 'Edit';
  if (titleLower.includes('edit_file') || titleLower.includes('edit file')) return 'Edit';
  if (titleLower.includes('execute') || titleLower.includes('shell')) return 'Bash';
  if (titleLower.includes('glob')) return 'Glob';
  if (titleLower.includes('grep')) return 'Grep';
  if (titleLower.includes('task') || titleLower.includes('subagent')) return 'Task';
  if (titleLower.includes('todo') || titleLower.includes('plan')) return 'TodoWrite';

  // Pattern-based heuristics from title structure
  if (/\bin\b.*\bwithin\b/.test(title) || /\bin\b.*\.\w+$/.test(title)) return 'Grep';
  if (title.includes('*') || title.includes('?')) return 'Glob';
  if (/^packages\/|^src\/|^\.\/|^\//.test(title) && !title.includes(' ')) return 'Read';

  return 'Tool';
}

/**
 * Build the canonical tool input from ACP event data.
 *
 * Given a resolved tool name and ACP protocol fields, constructs the
 * input object with the field names the client tool cards expect:
 *   Read/Write/Edit → file_path
 *   Bash            → command
 *   Glob            → pattern
 *   Grep            → pattern (+ optional path)
 *   WebFetch        → url
 *   WebSearch       → query
 *   Task            → description
 *   Think           → content
 */
export function buildACPToolInput(
  toolName: string,
  data: ACPToolCallData,
): Record<string, unknown> {
  const raw: Record<string, unknown> =
    data.rawInput != null && typeof data.rawInput === 'object'
      ? { ...(data.rawInput as Record<string, unknown>) }
      : {};

  const input: Record<string, unknown> = { ...raw };

  const replacement = TOOL_INPUT_FILLERS.get(toolName)?.(input, data, toolName);
  if (replacement) return replacement;

  // Always include the ACP title as description fallback
  if (data.title && !input.description) {
    input.description = data.title;
  }

  return input;
}

/**
 * Per-tool filler: mutates `input` in place to add the canonical fields the
 * client card expects. Returning an object replaces the whole input (and skips
 * the description fallback) — used by TodoWrite.
 */
type ToolInputFiller = (
  input: Record<string, unknown>,
  data: ACPToolCallData,
  toolName: string,
) => Record<string, unknown> | undefined;

/** First value among `keys` that is not null/undefined (mirrors a `??` chain). */
function firstDefined(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (input[key] != null) return input[key];
  }
  return undefined;
}

/** Provider aliases for the file path, in priority order (last four are Cursor-specific). */
const FILE_PATH_ALIASES = [
  'path',
  'filePath',
  'filename',
  'file',
  'target_file',
  'abs_path',
  'absolute_path',
  'relative_workspace_path',
] as const;

type DiffBlock = { path?: string; oldText?: string; newText?: string };

/** Set `file_path` (when missing) from the first source that resolves one. */
function fillFilePath(
  input: Record<string, unknown>,
  data: ACPToolCallData,
  diff: DiffBlock | null,
): void {
  if (input.file_path) return;
  const resolved = resolveFilePath(input, data, diff);
  if (resolved) input.file_path = resolved.value;
}

/**
 * Resolve the file path from raw aliases, locations, diff, content blocks, then
 * title. Boxed so a location is used as-is even when its path is empty.
 */
function resolveFilePath(
  input: Record<string, unknown>,
  data: ACPToolCallData,
  diff: DiffBlock | null,
): { value: unknown } | null {
  const alias = firstDefined(input, FILE_PATH_ALIASES);
  if (alias) return { value: alias };
  if (data.locations?.length) return { value: data.locations[0].path };
  const fallback =
    diff?.path || extractPathFromContent(data.content) || extractPathFromTitle(data.title ?? '');
  return fallback ? { value: fallback } : null;
}

/**
 * Surface the diff's before/after text so the EditFileCard can render an
 * inline diff (it needs file_path + old_string + new_string).
 */
function fillDiffText(input: Record<string, unknown>, diff: DiffBlock): void {
  if (input.old_string == null && typeof diff.oldText === 'string') {
    input.old_string = diff.oldText;
  }
  if (input.new_string == null && typeof diff.newText === 'string') {
    input.new_string = diff.newText;
  }
}

const fillFileTool: ToolInputFiller = (input, data, toolName) => {
  // Cursor reports edits as a `diff` content block carrying the path plus
  // the before/after text — the only place the path appears for an edit.
  const diff = extractDiffBlock(data.content);
  fillFilePath(input, data, diff);
  if (toolName !== 'Read' && diff) fillDiffText(input, diff);
  return undefined;
};

const fillBash: ToolInputFiller = (input, data) => {
  if (!input.command) {
    input.command = firstDefined(input, ['cmd', 'shell_command', 'script']) ?? data.title;
  }
  return undefined;
};

const fillGlob: ToolInputFiller = (input, data) => {
  if (!input.pattern) {
    input.pattern = (input.glob as string) ?? extractGlobFromTitle(data.title) ?? data.title;
  }
  return undefined;
};

const fillGrep: ToolInputFiller = (input, data) => {
  if (input.pattern) return undefined;
  const searchMatch = data.title.match(/(?:for|searching)\s+['"]?([^'"]+)['"]?(?:\s+in\s+(\S+))?/i);
  if (searchMatch) {
    input.pattern = searchMatch[1].trim();
    if (searchMatch[2]) input.path = searchMatch[2];
  } else {
    input.pattern = firstDefined(input, ['query', 'search']) ?? data.title;
  }
  return undefined;
};

const fillWebFetch: ToolInputFiller = (input, data) => {
  if (!input.url) input.url = (input.href as string) ?? data.title;
  return undefined;
};

const fillWebSearch: ToolInputFiller = (input, data) => {
  if (!input.query) input.query = (input.search as string) ?? data.title;
  return undefined;
};

const fillTask: ToolInputFiller = (input, data) => {
  if (!input.description && data.title) input.description = data.title;
  return undefined;
};

const fillThink: ToolInputFiller = (input, data) => {
  if (!input.content && data.title) input.content = data.title;
  return undefined;
};

const fillTodoWrite: ToolInputFiller = (input) => {
  const todoInput = buildTodoWriteInputFromRaw(input);
  return todoInput ? { todos: todoInput.todos } : undefined;
};

const TOOL_INPUT_FILLERS = new Map<string, ToolInputFiller>([
  ['Read', fillFileTool],
  ['Write', fillFileTool],
  ['Edit', fillFileTool],
  ['Bash', fillBash],
  ['Glob', fillGlob],
  ['Grep', fillGrep],
  ['WebFetch', fillWebFetch],
  ['WebSearch', fillWebSearch],
  ['Task', fillTask],
  ['Think', fillThink],
  ['TodoWrite', fillTodoWrite],
]);

/** True when a built TodoWrite input has a non-empty checklist for the client card. */
export function hasRenderableTodoInput(input: Record<string, unknown>): boolean {
  const built = buildTodoWriteInputFromRaw(input);
  return built != null && built.todos.length > 0;
}

/** A single todo as the client's TodoList card expects it. */
export interface ACPTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Convert an ACP `plan` update's entries into a `TodoWrite` tool input.
 *
 * The client renders a rich checklist (TodoList) when a tool call is named
 * `TodoWrite` and its input carries `todos: [{ content, status }]`. ACP's
 * `PlanEntry` already uses those exact field names — `content` (NOT `title`
 * or `description`) and a `status` of `pending | in_progress | completed` —
 * so the mapping is direct. Entries with no usable text are dropped.
 */
function parseTodoItemsFromArray(entries: unknown[] | undefined): ACPTodoItem[] {
  const todos: ACPTodoItem[] = [];
  for (const raw of entries ?? []) {
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
    todos.push({ content, status });
  }
  return todos;
}

export function buildTodoWriteInputFromPlanEntries(entries: unknown[] | undefined): {
  todos: ACPTodoItem[];
} {
  return { todos: parseTodoItemsFromArray(entries) };
}

/**
 * Normalize Cursor `cursor/update_todos`, plan entries, or tool-result payloads
 * into the `{ todos: [{ content, status }] }` shape the client TodoList expects.
 */
export function buildTodoWriteInputFromRaw(
  raw: Record<string, unknown>,
): { todos: ACPTodoItem[] } | null {
  for (const key of ['todos', 'entries', 'items'] as const) {
    const arr = raw[key];
    if (Array.isArray(arr)) {
      const todos = parseTodoItemsFromArray(arr);
      if (todos.length > 0) return { todos };
    }
  }
  const outcome = raw.outcome;
  if (outcome && typeof outcome === 'object') {
    const o = outcome as Record<string, unknown>;
    if (o.outcome === 'accepted' && Array.isArray(o.todos)) {
      const todos = parseTodoItemsFromArray(o.todos);
      if (todos.length > 0) return { todos };
    }
  }
  return null;
}

/** Merge todos from a completed tool result when the initial tool_call lacked rawInput. */
export function enrichTodoWriteInputFromOutput(
  input: Record<string, unknown>,
  rawOutput: unknown,
): Record<string, unknown> {
  if (hasRenderableTodoInput(input)) return input;
  if (rawOutput != null && typeof rawOutput === 'object') {
    const built = buildTodoWriteInputFromRaw(rawOutput as Record<string, unknown>);
    if (built) return { todos: built.todos };
  }
  if (typeof rawOutput === 'string') {
    try {
      const parsed = JSON.parse(rawOutput) as unknown;
      if (parsed && typeof parsed === 'object') {
        const built = buildTodoWriteInputFromRaw(parsed as Record<string, unknown>);
        if (built) return { todos: built.todos };
      }
    } catch {
      /* not JSON */
    }
  }
  return input;
}

/**
 * Extract completed tool output from an ACP update.
 *
 * ACP tool results come in multiple formats:
 * 1. rawOutput (string or object) — preferred
 * 2. content[] blocks (text, diff, terminal)
 * 3. fallbackTitle as last resort
 */
export function extractACPToolOutput(
  rawOutput: unknown,
  content: unknown[] | undefined,
  fallbackTitle: string,
): string {
  if (rawOutput != null) {
    if (typeof rawOutput === 'string') return rawOutput;
    // Cursor read_file returns `{ content: "<file text>" }`; unwrap so the
    // ReadFileCard sees the actual file contents instead of a JSON blob.
    if (typeof rawOutput === 'object') {
      const obj = rawOutput as Record<string, unknown>;
      const inner =
        (typeof obj.content === 'string' && obj.content) ||
        (typeof obj.text === 'string' && obj.text) ||
        (typeof obj.output === 'string' && obj.output) ||
        (typeof obj.stdout === 'string' && obj.stdout);
      if (inner) return inner;
    }
    return JSON.stringify(rawOutput);
  }

  if (content?.length) {
    const output = (content as any[])
      .map((c: any) => {
        if (c.type === 'content' && c.content) {
          const items = Array.isArray(c.content) ? c.content : [c.content];
          return items
            .map((b: any) => {
              if (b.type === 'text') return b.text;
              // Embedded resource — file content lives in resource.text.
              if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') {
                return b.resource.text;
              }
              return '';
            })
            .filter(Boolean)
            .join('\n');
        }
        // Cursor diff blocks carry oldText/newText (not a `diff` string).
        if (c.type === 'diff') return c.diff ?? c.newText ?? '';
        if (c.type === 'terminal') return c.output ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (output) return output;
  }

  return fallbackTitle || 'Done';
}

/**
 * Extract a file path from ACP ToolCallContent blocks. Reads `resource_link.uri`
 * and embedded `resource.uri`, stripping any `file://` prefix. Returns null if
 * no path-like URI is found.
 */
function extractPathFromContent(content: unknown[] | undefined): string | null {
  if (!content?.length) return null;
  for (const c of content as any[]) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content) {
      const items = Array.isArray(c.content) ? c.content : [c.content];
      for (const b of items) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'resource_link' && typeof b.uri === 'string') {
          return stripFileUri(b.uri);
        }
        if (b.type === 'resource' && b.resource && typeof b.resource.uri === 'string') {
          return stripFileUri(b.resource.uri);
        }
      }
    }
  }
  return null;
}

function stripFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

/**
 * Find a Cursor `diff` ToolCallContent block. Cursor reports edits as a
 * top-level `{ type: 'diff', path, oldText, newText }` entry in `content[]` —
 * the only carrier of the edited file's path and before/after text.
 */
function extractDiffBlock(
  content: unknown[] | undefined,
): { path?: string; oldText?: string; newText?: string } | null {
  if (!content?.length) return null;
  for (const c of content as any[]) {
    if (c && typeof c === 'object' && c.type === 'diff') {
      return {
        path: typeof c.path === 'string' ? stripFileUri(c.path) : undefined,
        oldText: typeof c.oldText === 'string' ? c.oldText : undefined,
        newText: typeof c.newText === 'string' ? c.newText : undefined,
      };
    }
  }
  return null;
}

/**
 * Detect Gemini/Codex "preamble" titles that narrate intent before a real
 * tool call (e.g. `[current working directory /repo] (Check git status…)`).
 *
 * Returns the inner reason text when the title matches the preamble shape,
 * otherwise `null`. Adapters route matches through the Think card path so
 * they don't render as broken, half-empty tool cards.
 */
export function parseACPPreambleTitle(title: string | undefined): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (!/^\[current working directory\b/i.test(trimmed)) return null;

  // Drop one or more leading `[…]` cwd brackets.
  let rest = trimmed;
  while (/^\[current working directory\b/i.test(rest)) {
    const close = rest.indexOf(']');
    if (close === -1) break;
    rest = rest.slice(close + 1).trimStart();
  }

  // Pull out the parenthetical reason, if any.
  const paren = rest.match(/^\(([\s\S]*?)\)\s*$/);
  if (paren) return paren[1].trim();
  return rest.length > 0 ? rest : null;
}

// ── Private helpers ──────────────────────────────────────────

/** Extract a file/directory path from an ACP tool title. */
function extractPathFromTitle(title: string): string | null {
  if (title.startsWith('/') || title.startsWith('~')) return title;

  const match = title.match(/^(?:Listing|Reading|Editing|Writing|Viewing|Opening)\s+(\/\S+)/i);
  if (match) return match[1];

  const match2 = title.match(/(\/\S+)/);
  if (match2) return match2[1];

  return null;
}

/** Extract a glob pattern from an ACP tool title. */
function extractGlobFromTitle(title: string): string | null {
  const match = title.match(/(?:matching|for|pattern)\s+(\S+)/i);
  if (match) return match[1];

  if (/[*?]/.test(title)) {
    const tokens = title.split(/\s+/);
    const globToken = tokens.find((t) => /[*?]/.test(t));
    if (globToken) return globToken;
  }

  return null;
}
