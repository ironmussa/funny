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

const SHELL_COMMANDS_WITH_SUBCOMMANDS = new Set([
  'aws',
  'az',
  'bun',
  'bunx',
  'cargo',
  'deno',
  'docker',
  'docker-compose',
  'gcloud',
  'gh',
  'git',
  'go',
  'helm',
  'kubectl',
  'make',
  'modal',
  'npm',
  'npx',
  'nx',
  'pip',
  'pip3',
  'pipx',
  'pnpm',
  'poetry',
  'python',
  'python3',
  'railway',
  'rustup',
  'supabase',
  'terraform',
  'turbo',
  'uv',
  'uvx',
  'vercel',
  'vitest',
  'yarn',
]);

const SHELL_TOKEN_RE = /(\s+|&amp;&amp;|\|\||&gt;&gt;?|&lt;&lt;?|[|;()])|([^\s|;()]+)/g;
const SHELL_REDIRECT_RE = /^(?:&gt;&gt;?|&lt;&lt;?)$/;
const SHELL_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(=(.*))$/;
const SHELL_FLAG_RE = /^(--?[A-Za-z][\w-]*)(=(.*))?$/;
const SHELL_VARIABLE_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/;
const SHELL_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?(?:[kKmMgGtTpP])?$/;
const SHELL_BARE_WORD_RE = /^[A-Za-z][\w@+.-]*$/;
const SHELL_URL_RE = /^(?:https?|ssh|git):\/\/\S+$/;
const SHELL_PATH_RE =
  /^(?:~?\/|\.{1,2}\/|[A-Za-z0-9_@%+=:,.-]+\/|[A-Za-z0-9_@%+=:,-]+\.[A-Za-z0-9]{1,8}(?:[?#].*)?$)/;

interface ShellHighlightContext {
  expectCommand: boolean;
  currentCommand: string | null;
  subcommandCount: number;
  acceptingSubcommands: boolean;
}

type ShellTokenKind =
  | 'space'
  | 'separator'
  | 'redirect'
  | 'assignment'
  | 'flag'
  | 'variable'
  | 'number'
  | 'url'
  | 'path'
  | 'string'
  | 'command'
  | 'subcommand'
  | 'word';

function createShellHighlightContext(): ShellHighlightContext {
  return {
    expectCommand: true,
    currentCommand: null,
    subcommandCount: 0,
    acceptingSubcommands: false,
  };
}

function resetShellCommandContext(ctx: ShellHighlightContext) {
  ctx.expectCommand = true;
  ctx.currentCommand = null;
  ctx.subcommandCount = 0;
  ctx.acceptingSubcommands = false;
}

function wrapShellToken(token: string, className: string): string {
  return `<span class="${className}">${token}</span>`;
}

function normalizeShellCommand(token: string): string {
  const unquoted = token.replace(/^&quot;|&quot;$/g, '').replace(/^['"]|['"]$/g, '');
  const parts = unquoted.split('/');
  return (parts[parts.length - 1] || unquoted).toLowerCase();
}

function isShellSeparator(token: string): boolean {
  return (
    token === '&amp;&amp;' ||
    token === '||' ||
    token === '|' ||
    token === ';' ||
    token === '(' ||
    token === ')'
  );
}

function isShellString(token: string): boolean {
  return (
    (token.startsWith('&quot;') && token.endsWith('&quot;')) ||
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  );
}

function isShellPath(token: string): boolean {
  return SHELL_PATH_RE.test(token);
}

function canHighlightSubcommand(token: string, ctx: ShellHighlightContext): boolean {
  return (
    ctx.acceptingSubcommands &&
    ctx.subcommandCount < 3 &&
    !!ctx.currentCommand &&
    SHELL_COMMANDS_WITH_SUBCOMMANDS.has(ctx.currentCommand) &&
    SHELL_BARE_WORD_RE.test(token) &&
    !isShellPath(token)
  );
}

function getShellTokenKind(token: string, ctx: ShellHighlightContext): ShellTokenKind {
  if (/^\s+$/.test(token)) return 'space';
  if (isShellSeparator(token)) return 'separator';
  if (SHELL_REDIRECT_RE.test(token)) return 'redirect';
  if (SHELL_ASSIGNMENT_RE.test(token)) return 'assignment';
  if (ctx.expectCommand) return 'command';
  if (SHELL_FLAG_RE.test(token)) return 'flag';
  if (SHELL_VARIABLE_RE.test(token)) return 'variable';
  if (SHELL_NUMBER_RE.test(token)) return 'number';
  if (SHELL_URL_RE.test(token)) return 'url';
  if (isShellPath(token)) return 'path';
  if (isShellString(token)) return 'string';
  if (canHighlightSubcommand(token, ctx)) return 'subcommand';
  return 'word';
}

function renderShellValue(value: string): string {
  if (!value) return '';
  if (SHELL_VARIABLE_RE.test(value)) return wrapShellToken(value, 'hljs-variable');
  if (SHELL_NUMBER_RE.test(value)) return wrapShellToken(value, 'hljs-number');
  if (SHELL_URL_RE.test(value) || isShellPath(value) || isShellString(value)) {
    return wrapShellToken(value, 'hljs-string');
  }
  return wrapShellToken(value, 'hljs-string');
}

function renderShellToken(token: string, kind: ShellTokenKind): string {
  switch (kind) {
    case 'separator':
    case 'redirect':
      return wrapShellToken(token, 'hljs-operator');
    case 'assignment': {
      const match = token.match(SHELL_ASSIGNMENT_RE);
      if (!match) return token;
      return `${wrapShellToken(match[1], 'hljs-variable')}=${renderShellValue(match[3] ?? '')}`;
    }
    case 'flag': {
      const match = token.match(SHELL_FLAG_RE);
      if (!match) return wrapShellToken(token, 'hljs-attr');
      if (match[2] == null) return wrapShellToken(token, 'hljs-attr');
      return `${wrapShellToken(match[1], 'hljs-attr')}=${renderShellValue(match[3] ?? '')}`;
    }
    case 'variable':
      return wrapShellToken(token, 'hljs-variable');
    case 'number':
      return wrapShellToken(token, 'hljs-number');
    case 'url':
    case 'path':
    case 'string':
      return wrapShellToken(token, 'hljs-string');
    case 'command':
      return wrapShellToken(token, 'hljs-title function_');
    case 'subcommand':
      return wrapShellToken(token, 'hljs-built_in');
    case 'space':
    case 'word':
      return token;
  }
}

function advanceShellContext(token: string, kind: ShellTokenKind, ctx: ShellHighlightContext) {
  if (kind === 'space') {
    if (token.includes('\n')) resetShellCommandContext(ctx);
    return;
  }
  if (kind === 'separator') {
    resetShellCommandContext(ctx);
    return;
  }
  if (kind === 'redirect') {
    ctx.acceptingSubcommands = false;
    return;
  }
  if (kind === 'assignment' && ctx.expectCommand) return;
  if (kind === 'command') {
    ctx.expectCommand = false;
    ctx.currentCommand = normalizeShellCommand(token);
    ctx.subcommandCount = 0;
    ctx.acceptingSubcommands = true;
    return;
  }
  if (kind === 'subcommand') {
    ctx.subcommandCount += 1;
    return;
  }
  ctx.acceptingSubcommands = false;
}

function augmentShellText(text: string, ctx: ShellHighlightContext): string {
  return text.replace(SHELL_TOKEN_RE, (token) => {
    const kind = getShellTokenKind(token, ctx);
    const rendered = renderShellToken(token, kind);
    advanceShellContext(token, kind, ctx);
    return rendered;
  });
}

function advanceShellContextForHtml(html: string, ctx: ShellHighlightContext) {
  const text = html.replace(/<[^>]+>/g, '');
  text.replace(SHELL_TOKEN_RE, (token) => {
    const kind = getShellTokenKind(token, ctx);
    advanceShellContext(token, kind, ctx);
    return token;
  });
}

function readSpanBlock(html: string, start: number): { raw: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < html.length) {
    if (html.startsWith('<span', i)) {
      depth++;
      const tagEnd = html.indexOf('>', i);
      i = tagEnd === -1 ? html.length : tagEnd + 1;
    } else if (html.startsWith('</span>', i)) {
      depth--;
      i += 7;
      if (depth === 0) return { raw: html.slice(start, i), end: i };
    } else {
      i++;
    }
  }
  return { raw: html.slice(start), end: html.length };
}

/**
 * hljs's bash grammar leaves CLI invocations (commands, flags, paths, and env
 * assignments) mostly untokenized, so real-world command snippets render as a
 * single flat color. Walk the HTML and add shell-specific spans without touching
 * tokens that hljs already highlighted.
 */
function augmentShellHighlight(html: string): string {
  const ctx = createShellHighlightContext();
  let result = '';
  let i = 0;

  while (i < html.length) {
    if (html.startsWith('<span', i)) {
      const span = readSpanBlock(html, i);
      result += span.raw;
      advanceShellContextForHtml(span.raw, ctx);
      i = span.end;
      continue;
    }

    const nextSpan = html.indexOf('<span', i);
    const end = nextSpan === -1 ? html.length : nextSpan;
    result += augmentShellText(html.slice(i, end), ctx);
    i = end;
  }

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
