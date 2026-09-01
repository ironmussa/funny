import { performance } from 'node:perf_hooks';

import { FileFinder, type GrepMatch } from '@ff-labs/fff-node';
import { scoreFilePath } from '@funny/shared/lib/file-search';

import { resolveGitFiles } from '../../utils/git-files.js';
import { searchText, type TextSearchOptions } from './legacy-ripgrep-adapter.js';

export interface RankedFileMatch {
  path: string;
  score: number;
  indices: number[];
}

export interface NormalizedTextMatch {
  path: string;
  line: number;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface BenchmarkTextResult {
  matches: NormalizedTextMatch[];
  truncated: boolean;
}

export interface SearchBenchmarkAdapter {
  readonly name: 'current' | 'fff';
  readonly fileReadyMs: number;
  readonly contentReadyMs: number;
  readonly indexedFiles: number;
  fileSearch(query: string, limit: number): RankedFileMatch[];
  textSearch(options: TextSearchOptions): Promise<BenchmarkTextResult>;
  listIndexedFiles(): string[];
  destroy(): void;
}

interface ScoredPath {
  path: string;
  score: number;
  indices: number[];
}

export async function createCurrentAdapter(root: string): Promise<SearchBenchmarkAdapter> {
  const startedAt = performance.now();
  const files = await resolveGitFiles(root);
  const readyMs = performance.now() - startedAt;

  return {
    name: 'current',
    fileReadyMs: readyMs,
    contentReadyMs: readyMs,
    indexedFiles: files.length,
    fileSearch(query, limit) {
      return scoreCurrentPaths(files, query, limit);
    },
    async textSearch(options) {
      const result = await searchText(root, options);
      if (result.isErr()) throw new Error(result.error.message);
      return {
        matches: result.value.files.flatMap((file) =>
          file.matches.map((match) => ({
            path: normalizeRelativePath(file.path),
            line: match.line,
            text: match.text.replace(/\r?\n$/, ''),
            ranges: match.ranges,
          })),
        ),
        truncated: result.value.truncated,
      };
    },
    listIndexedFiles() {
      return [...files];
    },
    destroy() {},
  };
}

export async function createFffAdapter(
  root: string,
  options: { disableWatch?: boolean; maxThreads?: number; timeoutMs?: number } = {},
): Promise<SearchBenchmarkAdapter> {
  const startedAt = performance.now();
  const created = FileFinder.create({
    basePath: root,
    disableWatch: options.disableWatch ?? true,
    aiMode: false,
  });
  if (!created.ok) throw new Error(`FFF initialization failed: ${created.error}`);

  const finder = created.value;
  const scanReady = await finder.waitForScan(options.timeoutMs ?? 30_000);
  if (!scanReady.ok || !scanReady.value) {
    finder.destroy();
    throw new Error(
      `FFF file-scan readiness failed: ${scanReady.ok ? 'timed out' : scanReady.error}`,
    );
  }
  const fileReadyMs = performance.now() - startedAt;
  const contentReady = await finder.waitForIndexReady(options.timeoutMs ?? 30_000);
  if (!contentReady.ok || !contentReady.value) {
    finder.destroy();
    throw new Error(
      `FFF content-index readiness failed: ${contentReady.ok ? 'timed out' : contentReady.error}`,
    );
  }
  const progress = finder.getScanProgress();
  if (!progress.ok) {
    finder.destroy();
    throw new Error(`FFF scan progress failed: ${progress.error}`);
  }
  const contentReadyMs = performance.now() - startedAt;

  return {
    name: 'fff',
    fileReadyMs,
    contentReadyMs,
    indexedFiles: progress.value.scannedFilesCount,
    fileSearch(query, limit) {
      const result = finder.fileSearch(query, {
        maxThreads: options.maxThreads ?? 1,
        pageSize: limit,
      });
      if (!result.ok) throw new Error(`FFF file search failed: ${result.error}`);
      return result.value.items.map((item, index) => ({
        path: normalizeRelativePath(item.relativePath),
        score: result.value.scores[index]?.total ?? 0,
        indices: fuzzyHighlightIndices(item.relativePath, query),
      }));
    },
    async textSearch(options) {
      return searchFffText(finder, options);
    },
    listIndexedFiles() {
      return listFffFiles(finder);
    },
    destroy() {
      finder.destroy();
    },
  };
}

function listFffFiles(finder: FileFinder): string[] {
  const files: string[] = [];
  const pageSize = 10_000;
  let pageIndex = 0;

  while (true) {
    const result = finder.glob('**/*', { pageIndex, pageSize });
    if (!result.ok) throw new Error(`FFF file listing failed: ${result.error}`);
    files.push(...result.value.items.map((item) => normalizeRelativePath(item.relativePath)));
    if (files.length >= result.value.totalMatched || result.value.items.length === 0) break;
    pageIndex += 1;
  }

  return files;
}

async function searchFffText(
  finder: FileFinder,
  options: TextSearchOptions,
): Promise<BenchmarkTextResult> {
  const maxResults = Math.max(1, Math.min(10_000, options.maxResults ?? 1_000));
  const { query, mode } = translateTextQuery(options);
  const includePatterns = splitGlobs(options.include);
  const excludeConstraints = splitGlobs(options.exclude).map((glob) =>
    glob.startsWith('!') ? glob : `!${glob}`,
  );
  const constraintGroups =
    includePatterns.length > 0 ? includePatterns.map((glob) => [glob]) : [[]];
  const byIdentity = new Map<string, NormalizedTextMatch>();
  let truncated = false;

  for (const includes of constraintGroups) {
    let cursor = null;
    do {
      const constrainedQuery = [...includes, ...excludeConstraints, query].join(' ');
      const result = finder.grep(constrainedQuery, {
        mode,
        smartCase: !options.caseSensitive,
        cursor,
        pageSize: maxResults,
        maxMatchesPerFile: maxResults,
      });
      if (!result.ok) throw new Error(`FFF text search failed: ${result.error}`);
      if (result.value.regexFallbackError) {
        throw new Error(`Invalid regular expression: ${result.value.regexFallbackError}`);
      }

      for (const match of result.value.items) {
        const normalized = normalizeFffMatch(match);
        const identity = `${normalized.path}:${normalized.line}:${JSON.stringify(normalized.ranges)}`;
        byIdentity.set(identity, normalized);
        if (byIdentity.size >= maxResults) break;
      }

      cursor = result.value.nextCursor;
      if (byIdentity.size >= maxResults) {
        truncated = cursor !== null || result.value.items.length >= maxResults;
        break;
      }
    } while (cursor);
    if (byIdentity.size >= maxResults) break;
  }

  return { matches: [...byIdentity.values()].slice(0, maxResults), truncated };
}

function translateTextQuery(options: TextSearchOptions): {
  query: string;
  mode: 'plain' | 'regex';
} {
  if (!options.wholeWord) {
    return { query: options.query, mode: options.regex ? 'regex' : 'plain' };
  }
  const source = options.regex ? options.query : escapeRegex(options.query);
  return { query: `\\b(?:${source})\\b`, mode: 'regex' };
}

function normalizeFffMatch(match: GrepMatch): NormalizedTextMatch {
  return {
    path: normalizeRelativePath(match.relativePath),
    line: match.lineNumber,
    text: match.lineContent.replace(/\r?\n$/, ''),
    ranges: match.matchRanges.map(([start, end]) => ({ start, end })),
  };
}

function splitGlobs(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreCurrentPaths(files: string[], query: string, limit: number): RankedFileMatch[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return files.slice(0, limit).map((path) => ({ path, score: 0, indices: [] }));
  }
  const lowerQuery = trimmed.toLowerCase();
  const caseSensitive = trimmed !== lowerQuery;
  const scored: ScoredPath[] = [];

  for (const path of files) {
    const haystack = caseSensitive ? path : path.toLowerCase();
    const result = scoreFilePath(haystack, caseSensitive ? trimmed : lowerQuery, caseSensitive);
    if (result) scored.push({ path, ...result });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return scored.slice(0, limit);
}

function fuzzyHighlightIndices(path: string, query: string): number[] {
  const normalizedPath = path.toLowerCase();
  const normalizedQuery = query
    .replace(/(^|\s)[!*?\w./-]+(?=\s)/g, ' ')
    .trim()
    .toLowerCase();
  const indices: number[] = [];
  let cursor = 0;
  for (const character of normalizedQuery) {
    const found = normalizedPath.indexOf(character, cursor);
    if (found === -1) return [];
    indices.push(found);
    cursor = found + 1;
  }
  return indices;
}
