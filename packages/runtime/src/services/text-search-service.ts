/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Text-search service backed by ripgrep. Mirrors what VSCode's "Search in
 * Files" panel does — spawn `rg --json`, parse the line-delimited JSON
 * events, group matches by file, return a capped result set.
 *
 * Ripgrep is resolved at first use via {@link findRipgrep} with a cascade of
 * fallbacks so the feature works even when Bun fails to hoist the
 * `@vscode/ripgrep` platform-specific optional dep into `node_modules/`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync, err, ok, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

const NS = 'text-search';

export interface TextSearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Glob(s) to include (e.g. `*.ts`, `src/**`). Comma-separated. */
  include?: string;
  /** Glob(s) to exclude. Comma-separated. */
  exclude?: string;
  /** Max matches across all files. Defaults to 1000. */
  maxResults?: number;
}

export interface TextSearchLineMatch {
  /** 1-based line number. */
  line: number;
  /** The raw line text (UTF-8 — binary files are skipped by rg). */
  text: string;
  /**
   * Byte-offset ranges within `text` that matched. Sorted; non-overlapping.
   * Used by the UI to highlight matches inline.
   */
  ranges: Array<{ start: number; end: number }>;
}

export interface TextSearchFileResult {
  /** Path relative to the search root (forward-slash separated). */
  path: string;
  matches: TextSearchLineMatch[];
}

export interface TextSearchResult {
  files: TextSearchFileResult[];
  /** Total match count across all files. */
  totalMatches: number;
  /** True when we hit `maxResults` and stopped reading rg output. */
  truncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

const DEFAULT_MAX_RESULTS = 1000;
const SEARCH_TIMEOUT_MS = 30_000;

let cachedRipgrepPath: string | null | undefined;

/**
 * Cascade resolver for the ripgrep binary. Tried in order:
 *
 *   1. `$FUNNY_RIPGREP_PATH` env override (used by tests, containerized runs).
 *   2. `@vscode/ripgrep` package — preferred when present, ships a vetted
 *      binary matching VSCode's. Fails silently if Bun didn't hoist the
 *      platform-specific package (known bug with optional deps).
 *   3. `rg` on `$PATH` — covers users who installed it via brew/apt/cargo.
 *
 * Resolved path is cached for the process lifetime.
 */
async function findRipgrep(): Promise<string | null> {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath;

  const envOverride = process.env.FUNNY_RIPGREP_PATH;
  if (envOverride && existsSync(envOverride)) {
    log.info('Using ripgrep from FUNNY_RIPGREP_PATH', { namespace: NS, path: envOverride });
    cachedRipgrepPath = envOverride;
    return envOverride;
  }

  try {
    const mod = (await import('@vscode/ripgrep')) as { rgPath?: string };
    if (mod.rgPath && existsSync(mod.rgPath)) {
      log.info('Using ripgrep from @vscode/ripgrep', { namespace: NS, path: mod.rgPath });
      cachedRipgrepPath = mod.rgPath;
      return mod.rgPath;
    }
  } catch {
    // Optional dep didn't resolve; fall through to PATH lookup.
  }

  try {
    const path = await whichOnPath('rg');
    if (path) {
      log.info('Using ripgrep from PATH', { namespace: NS, path });
      cachedRipgrepPath = path;
      return path;
    }
  } catch {
    // ignore
  }

  log.warn('ripgrep not found', { namespace: NS });
  cachedRipgrepPath = null;
  return null;
}

interface RgJsonMatchEvent {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
    submatches: Array<{ start: number; end: number }>;
  };
}

function buildRipgrepArgs(opts: TextSearchOptions, maxResults: number): string[] {
  const args: string[] = ['--json', '--max-count', String(maxResults)];
  if (opts.caseSensitive) args.push('--case-sensitive');
  else args.push('--smart-case');
  if (opts.wholeWord) args.push('--word-regexp');
  if (!opts.regex) args.push('--fixed-strings');
  if (opts.include) {
    for (const g of opts.include
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      args.push('--glob', g);
    }
  }
  if (opts.exclude) {
    for (const g of opts.exclude
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      args.push('--glob', `!${g}`);
    }
  }
  // The trailing '.' is REQUIRED: without an explicit search path, ripgrep
  // reads from stdin when stdin is a pipe (which it is under child_process).
  // That makes the process hang forever waiting for input.
  args.push('--', opts.query, '.');
  return args;
}

/**
 * Run a text search in `cwd`. Returns matches grouped by file. Truncates at
 * `maxResults` matches (across all files) — the UI surfaces this via the
 * `truncated` flag so users can refine their query.
 */
export function searchText(
  cwd: string,
  opts: TextSearchOptions,
): ResultAsync<TextSearchResult, DomainError> {
  return ResultAsync.fromSafePromise(searchTextImpl(cwd, opts)).andThen((r) => r);
}

async function searchTextImpl(
  cwd: string,
  opts: TextSearchOptions,
): Promise<Result<TextSearchResult, DomainError>> {
  const query = opts.query?.trim() ?? '';
  if (!query) return err(badRequest('query is required'));

  const rg = await findRipgrep();
  if (!rg) {
    return err(
      internal(
        'ripgrep not found. Install it (brew install ripgrep / apt install ripgrep / cargo install ripgrep) or set FUNNY_RIPGREP_PATH.',
      ),
    );
  }

  const maxResults = Math.max(1, Math.min(10_000, opts.maxResults ?? DEFAULT_MAX_RESULTS));
  const args = buildRipgrepArgs(opts, maxResults);
  const startedAt = performance.now();

  log.debug('Starting ripgrep search', {
    namespace: NS,
    cwd,
    queryLen: query.length,
    caseSensitive: !!opts.caseSensitive,
    wholeWord: !!opts.wholeWord,
    regex: !!opts.regex,
    maxResults,
  });

  const { stdout, stderr, exitCode } = await runProcess(rg, args, cwd, SEARCH_TIMEOUT_MS);

  // ripgrep exits 0 with matches, 1 with no matches, 2+ on real errors.
  if (exitCode !== 0 && exitCode !== 1) {
    return err(internal(`ripgrep exited ${exitCode}: ${stderr.slice(0, 500) || '(no stderr)'}`));
  }

  const filesByPath = new Map<string, TextSearchFileResult>();
  let totalMatches = 0;
  let truncated = false;

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (totalMatches >= maxResults) {
      truncated = true;
      break;
    }
    let evt: { type: string; data?: unknown };
    try {
      evt = JSON.parse(line) as { type: string; data?: unknown };
    } catch {
      continue;
    }
    if (evt.type !== 'match') continue;

    const data = (evt as RgJsonMatchEvent).data;
    const text = data.lines.text ?? '';
    const ranges = data.submatches.map((s) => ({ start: s.start, end: s.end }));
    const path = data.path.text;
    let entry = filesByPath.get(path);
    if (!entry) {
      entry = { path, matches: [] };
      filesByPath.set(path, entry);
    }
    entry.matches.push({ line: data.line_number, text, ranges });
    totalMatches += 1;
  }

  const durationMs = Math.round(performance.now() - startedAt);
  metric('search.text.duration_ms', durationMs, {
    attributes: { truncated: String(truncated), matches: String(totalMatches) },
  });

  return ok({
    files: Array.from(filesByPath.values()),
    totalMatches,
    truncated,
    durationMs,
  });
}

/**
 * Cross-runtime process runner — works under both `bun` (production) and
 * `node` (vitest). Buffers stdout/stderr fully and enforces a hard timeout.
 */
function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Close stdin so ripgrep can't accidentally block on it; also keep
    // process tree small.
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      log.warn('ripgrep search timed out', { namespace: NS, cwd, timeoutMs });
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

/**
 * `which`-equivalent that works under both Bun and Node. Returns the absolute
 * path to the binary, or null if not found.
 */
function whichOnPath(binary: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args = process.platform === 'win32' ? [binary] : ['-c', `command -v ${binary}`];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const path = out.trim().split('\n')[0]?.trim() ?? '';
      resolve(path && existsSync(path) ? path : null);
    });
    child.on('error', () => resolve(null));
  });
}
