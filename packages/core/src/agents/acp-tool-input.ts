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
export function inferACPToolName(
  kind: string | undefined,
  title: string,
  overrides?: { thinkToolName?: string },
): string {
  const thinkName = overrides?.thinkToolName ?? 'Task';

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

  const { title, locations, content } = data;
  const input: Record<string, unknown> = { ...raw };

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      if (!input.file_path) {
        const path =
          (input.path as string) ??
          (input.filePath as string) ??
          (input.filename as string) ??
          (input.file as string) ??
          // Cursor-specific aliases
          (input.target_file as string) ??
          (input.abs_path as string) ??
          (input.absolute_path as string) ??
          (input.relative_workspace_path as string);
        if (path) {
          input.file_path = path;
        } else if (locations?.length) {
          input.file_path = locations[0].path;
        } else {
          const fromContent = extractPathFromContent(content);
          if (fromContent) {
            input.file_path = fromContent;
          } else if (title) {
            const extracted = extractPathFromTitle(title);
            if (extracted) {
              input.file_path = extracted;
            }
          }
        }
      }
      break;
    }
    case 'Bash': {
      if (!input.command) {
        input.command =
          (input.cmd as string) ??
          (input.shell_command as string) ??
          (input.script as string) ??
          title;
      }
      break;
    }
    case 'Glob': {
      if (!input.pattern) {
        input.pattern = (input.glob as string) ?? extractGlobFromTitle(title) ?? title;
      }
      break;
    }
    case 'Grep': {
      if (!input.pattern) {
        const searchMatch = title.match(
          /(?:for|searching)\s+['"]?([^'"]+)['"]?(?:\s+in\s+(\S+))?/i,
        );
        if (searchMatch) {
          input.pattern = searchMatch[1].trim();
          if (searchMatch[2]) input.path = searchMatch[2];
        } else {
          input.pattern = (input.query as string) ?? (input.search as string) ?? title;
        }
      }
      break;
    }
    case 'WebFetch': {
      if (!input.url) {
        input.url = (input.href as string) ?? title;
      }
      break;
    }
    case 'WebSearch': {
      if (!input.query) {
        input.query = (input.search as string) ?? title;
      }
      break;
    }
    case 'Task': {
      if (!input.description && title) {
        input.description = title;
      }
      break;
    }
    case 'Think': {
      if (!input.content && title) {
        input.content = title;
      }
      break;
    }
  }

  // Always include the ACP title as description fallback
  if (title && !input.description) {
    input.description = title;
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
        if (c.type === 'diff') return c.diff ?? '';
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
