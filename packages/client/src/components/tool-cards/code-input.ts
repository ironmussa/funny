/**
 * Which tool inputs hold source code, and in which language, so tool cards can
 * show them highlighted. Shared by MCP tool cards (one code input per call) and
 * the generic card (every field of a built-in tool).
 */

/** Input keys holding source code, with the language they imply (if any). */
const CODE_KEYS = new Map(
  Object.entries({
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
  }),
);

/** Tool names that imply the language of their code input. */
const TOOL_LANGUAGES = new Map(
  Object.entries({
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
  }),
);

export interface CodeInput {
  key: string;
  code: string;
  language: string | null;
}

/** The input that is source code (shown highlighted), if the call has one. */
export function getCodeInput(parsed: Record<string, unknown>, tool: string): CodeInput | null {
  for (const [key, keyLanguage] of CODE_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    return { key, code: value, language: keyLanguage ?? toolLanguage(tool) };
  }
  return null;
}

function toolLanguage(tool: string): string | null {
  return TOOL_LANGUAGES.get(tool.toLowerCase()) ?? null;
}

type FieldLanguage = (parsed: Record<string, unknown>) => string;

/** Code fields of built-in tools whose language the generic keys can't tell. */
const PATCH_FIELDS = new Map<string, FieldLanguage>([['input', () => 'diff']]);
const TOOL_CODE_FIELDS = new Map<string, ReadonlyMap<string, FieldLanguage>>([
  [
    'NotebookEdit',
    new Map<string, FieldLanguage>([
      ['new_source', (parsed) => (parsed.cell_type === 'markdown' ? 'markdown' : 'python')],
    ]),
  ],
  ['apply_patch', PATCH_FIELDS],
  ['ApplyPatch', PATCH_FIELDS],
]);

/**
 * The language to highlight `parsed[key]` of a `tool` call in, or null when the
 * field is not code (or its language is unknown).
 */
export function codeFieldLanguage(
  tool: string,
  key: string,
  parsed: Record<string, unknown>,
): string | null {
  const fieldLanguage = TOOL_CODE_FIELDS.get(tool)?.get(key);
  if (fieldLanguage) return fieldLanguage(parsed);
  if (!CODE_KEYS.has(key)) return null;
  return CODE_KEYS.get(key) ?? toolLanguage(tool);
}
