import hljs from 'highlight.js/lib/core';

/**
 * Skip syntax highlighting for content exceeding this many lines.
 * highlight.js is sync and fast, but we still avoid pathological inputs.
 */
export const HIGHLIGHT_MAX_LINES = 50_000;

/* ── Language registry ── */

/**
 * Map file extensions to highlight.js language names.
 * Languages are registered lazily on first use.
 */
const EXT_TO_HLJS_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  xml: 'xml',
  html: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  php: 'php',
  vue: 'xml',
  svelte: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  ini: 'ini',
  env: 'ini',
  tf: 'ini',
  zig: 'plaintext',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  dart: 'dart',
  r: 'r',
  scala: 'scala',
  clj: 'clojure',
};

/**
 * Map hljs language name → dynamic import.
 * We only import what we need, avoiding the full 2MB+ hljs bundle.
 */
const LANG_IMPORTS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  sql: () => import('highlight.js/lib/languages/sql'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  lua: () => import('highlight.js/lib/languages/lua'),
  php: () => import('highlight.js/lib/languages/php'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  ini: () => import('highlight.js/lib/languages/ini'),
  // hcl not available in highlight.js; tf files map to 'ini' instead
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  dart: () => import('highlight.js/lib/languages/dart'),
  r: () => import('highlight.js/lib/languages/r'),
  scala: () => import('highlight.js/lib/languages/scala'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  diff: () => import('highlight.js/lib/languages/diff'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
};

const registeredLangs = new Set<string>();
const pendingRegistrations = new Map<string, Promise<void>>();

/**
 * Ensure a language is registered with hljs. Returns a Promise that resolves
 * once the language is ready. Subsequent calls for the same language are no-ops.
 */
export async function ensureLanguage(lang: string): Promise<boolean> {
  if (lang === 'plaintext' || lang === 'text') return true;

  // Resolve aliases (e.g. "tsx" → "typescript", "jsx" → "javascript")
  const resolved = resolveLang(lang);
  if (registeredLangs.has(resolved)) return true;

  const existing = pendingRegistrations.get(resolved);
  if (existing) {
    await existing;
    return registeredLangs.has(resolved);
  }

  const importFn = LANG_IMPORTS[resolved];
  if (!importFn) return false;

  const promise = importFn()
    .then((mod) => {
      const langDef = (mod as { default: unknown }).default;
      if (langDef) {
        hljs.registerLanguage(resolved, langDef as Parameters<typeof hljs.registerLanguage>[1]);
        registeredLangs.add(resolved);
      }
    })
    .catch(() => {
      // Silently fail — will fall back to plain text
    })
    .finally(() => {
      pendingRegistrations.delete(resolved);
    });

  pendingRegistrations.set(resolved, promise);
  await promise;
  return registeredLangs.has(resolved);
}

/**
 * Resolve a language name or extension alias to a registered hljs language.
 */
function resolveLang(lang: string): string {
  if (LANG_IMPORTS[lang]) return lang;
  return EXT_TO_HLJS_LANG[lang] ?? lang;
}

/**
 * Bounded set of common languages considered by content-based auto-detection.
 * Kept small on purpose: hljs auto-detect grows less reliable (and slower) the
 * more candidates it weighs, so we only include high-signal languages.
 */
const AUTODETECT_SUBSET = [
  'typescript',
  'javascript',
  'python',
  'json',
  'yaml',
  'bash',
  'go',
  'rust',
  'java',
  'cpp',
  'css',
  'xml',
  'markdown',
  'sql',
  'ruby',
  'php',
];

/**
 * Detect an hljs language from a code block's content. Used when no file path
 * is available to infer the language from (e.g. Cursor's ACP `read` tool calls
 * omit the path, so the extension is unknown). Registers the bounded
 * {@link AUTODETECT_SUBSET}, then runs hljs auto-detection limited to it.
 * Returns 'plaintext' when nothing matches with enough confidence.
 */
export async function detectLanguageFromContent(content: string): Promise<string> {
  if (!content.trim()) return 'plaintext';
  await Promise.all(AUTODETECT_SUBSET.map((l) => ensureLanguage(l)));
  const candidates = AUTODETECT_SUBSET.map(resolveLang).filter((l) => registeredLangs.has(l));
  if (candidates.length === 0) return 'plaintext';
  try {
    // Cap the sample so auto-detection stays cheap on large files.
    const sample = content.length > 20_000 ? content.slice(0, 20_000) : content;
    const result = hljs.highlightAuto(sample, candidates);
    // hljs relevance is a rough score; require a floor to avoid mislabeling
    // plain prose / config snippets as code.
    if (result.language && result.relevance >= 5) return result.language;
  } catch {
    // fall through to plaintext
  }
  return 'plaintext';
}

/**
 * Resolve a file extension to an hljs language name.
 */
export function extToHljsLang(ext: string): string {
  return EXT_TO_HLJS_LANG[ext.toLowerCase()] ?? 'plaintext';
}

/**
 * Get the file extension from a file path.
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/**
 * Resolve a file path to an hljs language name.
 */
export function filePathToHljsLang(filePath: string): string {
  return extToHljsLang(getFileExtension(filePath));
}

/* ── Synchronous highlighting ── */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SHELL_LANGS = new Set(['bash', 'shell', 'sh', 'zsh']);

/**
 * hljs's bash grammar leaves CLI invocations (flags, numbers, paths) untokenized,
 * so commands like `python -m foo --flag 30` render as a single flat color.
 * After hljs, walk the HTML and wrap shell argument shapes outside existing spans.
 */
function augmentShellHighlight(html: string): string {
  const augment = (text: string): string =>
    text
      .replace(
        /(^|\s)(--?[A-Za-z][\w-]*)/g,
        (_, lead, flag) => `${lead}<span class="hljs-attr">${flag}</span>`,
      )
      .replace(
        /(^|[\s=])(\d+(?:\.\d+)?)(?=\b)/g,
        (_, lead, num) => `${lead}<span class="hljs-number">${num}</span>`,
      );

  let result = '';
  let depth = 0;
  let buffer = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<span', i)) {
      if (depth === 0) {
        result += augment(buffer);
        buffer = '';
      }
      const end = html.indexOf('>', i);
      const tag = end === -1 ? html.slice(i) : html.slice(i, end + 1);
      result += tag;
      i += tag.length;
      depth++;
    } else if (html.startsWith('</span>', i)) {
      result += '</span>';
      i += 7;
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      buffer += html[i];
      i++;
    } else {
      result += html[i];
      i++;
    }
  }
  result += augment(buffer);
  return result;
}

/**
 * Highlight a single line of code synchronously.
 * Returns HTML string with hljs token classes.
 * Falls back to escaped plain text if the language isn't loaded.
 */
export function highlightLine(line: string, lang: string): string {
  const resolved = resolveLang(lang);
  if (
    !resolved ||
    resolved === 'plaintext' ||
    resolved === 'text' ||
    !registeredLangs.has(resolved)
  ) {
    return escapeHtml(line);
  }
  try {
    const value = hljs.highlight(line, { language: resolved, ignoreIllegals: true }).value;
    return SHELL_LANGS.has(resolved) ? augmentShellHighlight(value) : value;
  } catch {
    return escapeHtml(line);
  }
}

/**
 * Highlight a full code block synchronously.
 * Returns HTML string with hljs token classes.
 */
export function highlightCode(code: string, lang: string): string {
  const resolved = resolveLang(lang);
  if (
    !resolved ||
    resolved === 'plaintext' ||
    resolved === 'text' ||
    !registeredLangs.has(resolved)
  ) {
    return escapeHtml(code);
  }
  try {
    const value = hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
    return SHELL_LANGS.has(resolved) ? augmentShellHighlight(value) : value;
  } catch {
    return escapeHtml(code);
  }
}
