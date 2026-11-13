/**
 * Which tool inputs hold source code, and in which language, so tool cards can
 * show them highlighted. Shared by MCP tool cards (one code input per call) and
 * the generic card (every field of a built-in tool).
 */

/** Input keys holding source code, with the language they imply (if any). */
const CODE_KEYS: Record<string, string | null> = {
  code: null,
  script: null,
  source: null,
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'typescript',
  python: 'python',
  sql: 'sql',
  command: 'bash',
  shell: 'bash',
};

/** Tool names that imply the language of their code input. */
const TOOL_LANGUAGES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  sql: 'sql',
  query: 'sql',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
};

export interface CodeInput {
  key: string;
  code: string;
  language: string | null;
}

/** The input that is source code (shown highlighted), if the call has one. */
export function getCodeInput(parsed: Record<string, unknown>, tool: string): CodeInput | null {
  for (const [key, keyLanguage] of Object.entries(CODE_KEYS)) {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    return { key, code: value, language: keyLanguage ?? toolLanguage(tool) };
  }
  return null;
}

function toolLanguage(tool: string): string | null {
  return TOOL_LANGUAGES[tool.toLowerCase()] ?? null;
}

type FieldLanguage = (parsed: Record<string, unknown>) => string;

/** Code fields of built-in tools whose language the generic keys can't tell. */
const TOOL_CODE_FIELDS: Record<string, Record<string, FieldLanguage>> = {
  NotebookEdit: {
    new_source: (parsed) => (parsed.cell_type === 'markdown' ? 'markdown' : 'python'),
  },
  apply_patch: { input: () => 'diff' },
  ApplyPatch: { input: () => 'diff' },
};

/**
 * The language to highlight `parsed[key]` of a `tool` call in, or null when the
 * field is not code (or its language is unknown).
 */
export function codeFieldLanguage(
  tool: string,
  key: string,
  parsed: Record<string, unknown>,
): string | null {
  const fields = Object.hasOwn(TOOL_CODE_FIELDS, tool) ? TOOL_CODE_FIELDS[tool] : null;
  if (fields && Object.hasOwn(fields, key)) return fields[key](parsed);
  if (!Object.hasOwn(CODE_KEYS, key)) return null;
  return CODE_KEYS[key] ?? toolLanguage(tool);
}
