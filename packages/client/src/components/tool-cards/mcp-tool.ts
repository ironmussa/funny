/**
 * Pure helpers for MCP tool calls (`mcp__<server>__<tool>`): name parsing,
 * the header summary, the code-like input to highlight, and the MCP result
 * envelope (`{ content: [...], isError, structuredContent, _meta }`) turned
 * into renderable parts instead of raw JSON.
 */

export interface McpToolName {
  server: string;
  tool: string;
}

/** `mcp__cua_repl__js` → `{ server: 'cua_repl', tool: 'js' }`; null for non-MCP names. */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** Display names of MCP servers seen in threads; others are humanized from their id. */
const SERVER_NAMES: Record<string, string> = {
  linear: 'Linear',
  'linear-server': 'Linear',
  railway: 'Railway',
  'chrome-devtools': 'Chrome DevTools',
  'playwright-test': 'Playwright',
  playwright: 'Playwright',
  codegraph: 'CodeGraph',
  convex: 'Convex',
  supabase: 'Supabase',
  github: 'GitHub',
  funny: 'funny',
  funny_browser: 'Browser',
  cua_repl: 'REPL',
  'coplay-mcp': 'Coplay',
};

/**
 * Friendly actions of well-known tools, as i18n keys under `tools.mcp`.
 * Tools not listed get their id humanized (`get_issue` → "Get issue").
 */
const KNOWN_ACTIONS: Record<string, string> = {
  'funny/funny_spawn': 'backgroundJob',
  'funny/funny_watch': 'scheduledCheck',
  'funny/funny_spawn_thread': 'newThread',
  'funny/funny_search_threads': 'searchThreads',
  'cua_repl/js': 'runJavaScript',
  'funny_browser/browser_open': 'browserOpen',
  'funny_browser/browser_navigate': 'browserNavigate',
  'funny_browser/browser_snapshot': 'browserSnapshot',
  'funny_browser/browser_act': 'browserAct',
  'funny_browser/browser_evaluate': 'browserEvaluate',
  'funny_browser/browser_wait_for': 'browserWaitFor',
  'funny_browser/browser_status': 'browserStatus',
  'funny_browser/browser_resize': 'browserResize',
  'funny_browser/browser_close': 'browserClose',
};

/** funny's own browser tools (`mcp__funny_browser__*`) — the card offers "Show in panel". */
export function isBrowserTool(mcp: McpToolName): boolean {
  return mcp.server === 'funny_browser';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type Summarizer = (parsed: Record<string, unknown>) => string | null;

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function actTarget(parsed: Record<string, unknown>): string | null {
  const x = num(parsed.x);
  const y = num(parsed.y);
  return str(parsed.ref) ?? (x !== null && y !== null ? `(${x}, ${y})` : null);
}

function actDetail(parsed: Record<string, unknown>): string | null {
  const text = str(parsed.text);
  if (text) return `"${firstLine(text, 60)}"`;
  return str(parsed.key) ?? (Array.isArray(parsed.values) ? parsed.values.join(', ') : null);
}

/** `click e7`, `fill e3 · "me@x.com"`, `press · Enter`, `double click (10, 20)`. */
const summarizeAct: Summarizer = (parsed) => {
  const action = str(parsed.action)?.replace(/_/g, ' ') ?? 'act';
  const head = [action, actTarget(parsed)].filter(Boolean).join(' ');
  const detail = actDetail(parsed);
  return detail ? `${head} · ${detail}` : head;
};

const summarizeWait: Summarizer = (parsed) => {
  const gone = str(parsed.textGone);
  const ms = num(parsed.timeMs);
  return (
    str(parsed.text) ??
    (gone ? `gone: ${gone}` : null) ??
    str(parsed.url) ??
    str(parsed.ref) ??
    (ms !== null ? `${ms}ms` : null)
  );
};

/** One-line summaries of funny's browser tool calls, by tool. */
const BROWSER_SUMMARIES: Record<string, Summarizer> = {
  browser_open: (p) => str(p.url),
  browser_navigate: (p) => str(p.url) ?? str(p.action),
  browser_act: summarizeAct,
  browser_evaluate: (p) => (str(p.expression) ? firstLine(str(p.expression) as string, 120) : null),
  browser_wait_for: summarizeWait,
  browser_resize: (p) => {
    const w = num(p.width);
    const h = num(p.height);
    return w !== null && h !== null ? `${w}×${h}` : null;
  },
  browser_snapshot: (p) => (p.screenshot === true ? 'with screenshot' : null),
};

/** "Get issue" from `get_issue`, `getIssue` or `codegraph_search` (server prefix dropped). */
function humanizeAction(server: string, tool: string): string {
  let id = tool;
  for (const sep of ['_', '-', '.']) {
    const prefix = `${server}${sep}`;
    if (id.toLowerCase().startsWith(prefix.toLowerCase()) && id.length > prefix.length) {
      id = id.slice(prefix.length);
      break;
    }
  }
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return tool;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function humanizeServer(server: string): string {
  const known = SERVER_NAMES[server] ?? SERVER_NAMES[server.toLowerCase()];
  if (known) return known;
  return server
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The card title: "Linear · Get issue", "funny · Background job". */
export function mcpToolTitle(mcp: McpToolName, t: (key: string) => string): string {
  const known = KNOWN_ACTIONS[`${mcp.server}/${mcp.tool}`];
  const action = known ? t(`tools.mcp.${known}`) : humanizeAction(mcp.server, mcp.tool);
  return `${humanizeServer(mcp.server)} · ${action}`;
}

/** Input keys that usually describe the call, in priority order. */
const SUMMARY_KEYS = [
  'title',
  'subject',
  'label',
  'intent',
  'description',
  'query',
  'task',
  'url',
  'path',
  'file_path',
  'id',
  'issueId',
  'name',
  'command',
  'prompt',
];

/** A one-line description of the call for the card header, with the input it came from. */
export function getMcpSummary(
  parsed: Record<string, unknown>,
  mcp?: McpToolName,
): { key: string; text: string } | null {
  if (mcp && isBrowserTool(mcp)) {
    const text = BROWSER_SUMMARIES[mcp.tool]?.(parsed) ?? null;
    // `key: ''` — the summary is composed from several inputs; keep them all listed.
    return text ? { key: '', text } : null;
  }
  for (const key of SUMMARY_KEYS) {
    const value = parsed[key];
    const text = typeof value === 'string' ? firstLine(value, 120) : null;
    if (text) return { key, text };
  }
  return null;
}

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

export interface McpCodeInput {
  key: string;
  code: string;
  language: string | null;
}

/** The input that is source code (shown highlighted), if the call has one. */
export function getMcpCodeInput(
  parsed: Record<string, unknown>,
  tool: string,
): McpCodeInput | null {
  for (const [key, keyLanguage] of Object.entries(CODE_KEYS)) {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const toolLanguage = TOOL_LANGUAGES[tool.toLowerCase()] ?? null;
    return { key, code: value, language: keyLanguage ?? toolLanguage };
  }
  return null;
}

export type McpResultPart =
  | { kind: 'text'; text: string; markdown: boolean }
  | { kind: 'image'; src: string; mimeType: string }
  | { kind: 'resource'; uri: string; text: string | null };

export interface McpResult {
  parts: McpResultPart[];
  isError: boolean;
  /** `structuredContent` when the server returned one. */
  structured: unknown;
  /** Execution time reported in `_meta` (any `…DurationMs` key), if any. */
  durationMs: number | null;
}

const MARKDOWN_HINT = /(^|\n)(#{1,6} |[-*] |\d+\. |```|> )|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/;

function textPart(text: string): McpResultPart {
  return { kind: 'text', text, markdown: MARKDOWN_HINT.test(text) };
}

function contentPart(block: unknown): McpResultPart | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, any>;
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? textPart(b.text) : null;
    case 'image': {
      const mimeType = typeof b.mimeType === 'string' ? b.mimeType : 'image/png';
      // Only inline raster/vector data the browser renders as an image.
      if (typeof b.data !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) return null;
      return { kind: 'image', src: `data:${mimeType};base64,${b.data}`, mimeType };
    }
    case 'resource': {
      const r = b.resource ?? {};
      if (typeof r.uri !== 'string') return null;
      return { kind: 'resource', uri: r.uri, text: typeof r.text === 'string' ? r.text : null };
    }
    case 'resource_link':
      return typeof b.uri === 'string' ? { kind: 'resource', uri: b.uri, text: null } : null;
    default:
      return null;
  }
}

function durationFromMeta(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null;
  for (const [key, value] of Object.entries(meta)) {
    if (/durationms$/i.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * The tool output as an MCP result, or null when it is not one (plain text,
 * other JSON): callers then show the output as it is.
 */
export function parseMcpResult(output: string | undefined): McpResult | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const envelope = Array.isArray(value) ? { content: value } : (value as Record<string, any>);
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.content)) return null;
  const parts = envelope.content.map(contentPart);
  // Not an MCP envelope if any block is unrecognized: show the raw output instead.
  if (parts.some((p: McpResultPart | null) => p === null)) return null;
  const structured = envelope.structuredContent ?? envelope.structured_content ?? null;
  return {
    parts: parts as McpResultPart[],
    isError: envelope.isError === true || envelope.is_error === true,
    structured,
    durationMs: durationFromMeta(envelope._meta),
  };
}

/** First non-empty line of the result's text, for the collapsed preview. */
export function mcpResultPreview(result: McpResult, max = 120): string | null {
  for (const part of result.parts) {
    if (part.kind === 'text') {
      const line = firstLine(part.text, max);
      if (line) return line;
    }
    if (part.kind === 'image') return `[${part.mimeType}]`;
    if (part.kind === 'resource') return part.uri;
  }
  return null;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function firstLine(text: string, max: number): string | null {
  const line = text
    .split('\n')
    .find((l) => l.trim())
    ?.trim()
    .replace(/^#+\s*/, '');
  if (!line) return null;
  return line.length > max ? line.slice(0, max) + '…' : line;
}
