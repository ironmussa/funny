import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { FileFinder, type FileFinderApi, type GrepCursor } from '@ff-labs/fff-node';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { fileSearchHighlightIndices } from '@funny/shared/lib/file-search';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { metric, recordHistogram } from '../lib/telemetry.js';
import type {
  ProjectFileSearchResult,
  ProjectSearchNativeHealth,
  ProjectSearchHealth,
  ProjectSearchProvider,
  ProjectTextFileResult,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from './project-search-provider.js';

const NS = 'fff-search';
const DEFAULT_MAX_RESULTS = 1_000;
const MAX_RESULTS = 10_000;

type SearchOperation =
  | 'initialization'
  | 'list-files'
  | 'file-search'
  | 'text-search'
  | 'selection-tracking'
  | 'git-refresh'
  | 'rescan';
type SearchErrorCategory = 'native-load' | 'initialization' | 'scan' | 'query' | 'validation';

class FffInitializationError extends Error {
  constructor(
    readonly category: Extract<SearchErrorCategory, 'native-load' | 'initialization' | 'scan'>,
    message: string,
  ) {
    super(message);
  }
}

export interface FffProviderOptions {
  frecencyDbPath: string;
  historyDbPath: string;
  scanTimeoutMs?: number;
}

export function getFffNativeHealth(): ProjectSearchNativeHealth {
  try {
    FileFinder.ensureLoaded();
    const health = FileFinder.healthCheckStatic();
    if (!health.ok) {
      return { available: false, version: null, failureReason: 'health-check' };
    }
    return { available: true, version: health.value.version };
  } catch {
    return { available: false, version: null, failureReason: 'native-load' };
  }
}

export function createFffProjectSearchProvider(
  cwd: string,
  options: FffProviderOptions,
): ResultAsync<ProjectSearchProvider, DomainError> {
  const startedAt = performance.now();
  return ResultAsync.fromPromise(createProvider(cwd, options), (cause) => {
    recordSearchOperation({
      operation: 'initialization',
      status: 'error',
      startedAt,
      cwdId: safeCwdId(cwd),
      errorCategory: initializationErrorCategory(cause),
    });
    return unavailableFailure(cause);
  }).map((provider) => {
    recordSearchOperation({
      operation: 'initialization',
      status: 'ok',
      startedAt,
      cwdId: safeCwdId(cwd),
      indexedCount: provider.health().indexedFiles,
    });
    return provider;
  });
}

async function createProvider(
  cwd: string,
  options: FffProviderOptions,
): Promise<ProjectSearchProvider> {
  mkdirSync(dirname(options.frecencyDbPath), { recursive: true });
  try {
    FileFinder.ensureLoaded();
  } catch (cause) {
    throw new FffInitializationError(
      'native-load',
      `FFF native binding unavailable: ${safeReason(cause)}`,
    );
  }

  const created = FileFinder.create({
    basePath: cwd,
    frecencyDbPath: options.frecencyDbPath,
    historyDbPath: options.historyDbPath,
    aiMode: false,
  });
  if (!created.ok) {
    throw new FffInitializationError(
      'initialization',
      `FFF initialization failed: ${safeReason(created.error)}`,
    );
  }

  const finder = created.value;
  const ready = await finder.waitForScan(options.scanTimeoutMs ?? 30_000);
  if (!ready.ok || !ready.value) {
    finder.destroy();
    throw new FffInitializationError(
      'scan',
      `FFF initial scan failed: ${ready.ok ? 'timed out' : safeReason(ready.error)}`,
    );
  }

  return new FffProjectSearchProvider(cwd, finder);
}

export class FffProjectSearchProvider implements ProjectSearchProvider {
  private revision = 1;
  private disposed = false;
  private readonly unsubscribe: (() => void) | null;
  private readonly cwdId: string;

  constructor(
    readonly cwd: string,
    private readonly finder: FileFinderApi,
  ) {
    this.cwdId = safeCwdId(cwd);
    const watched = finder.watch((events) => {
      this.revision += 1;
      if (events.some((event) => event.kind === 'rescan')) void this.rescan();
    });
    this.unsubscribe = watched.ok ? watched.value : null;
  }

  get version(): number {
    return this.revision;
  }

  listFiles(): Result<string[], DomainError> {
    const startedAt = performance.now();
    const files: string[] = [];
    const pageSize = 10_000;
    let pageIndex = 0;
    while (true) {
      const result = this.finder.glob('**/*', { pageIndex, pageSize });
      if (!result.ok) {
        recordSearchOperation({
          operation: 'list-files',
          status: 'error',
          startedAt,
          cwdId: this.cwdId,
          errorCategory: 'query',
        });
        return err(searchFailure('file listing', result.error));
      }
      files.push(...result.value.items.map((item) => normalizePath(item.relativePath)));
      if (files.length >= result.value.totalMatched || result.value.items.length === 0) break;
      pageIndex += 1;
    }
    recordSearchOperation({
      operation: 'list-files',
      status: 'ok',
      startedAt,
      cwdId: this.cwdId,
      resultCount: files.length,
      indexedCount: files.length,
    });
    return ok(files);
  }

  searchFiles(query: string, limit: number): Result<ProjectFileSearchResult, DomainError> {
    const cappedLimit = Math.max(1, Math.min(1_000, limit));
    const startedAt = performance.now();
    const result = query.trim()
      ? this.finder.fileSearch(query.trim(), { pageSize: cappedLimit, maxThreads: 1 })
      : this.finder.glob('**/*', { pageSize: cappedLimit, maxThreads: 1 });
    if (!result.ok) {
      recordSearchOperation({
        operation: 'file-search',
        status: 'error',
        startedAt,
        cwdId: this.cwdId,
        errorCategory: 'query',
      });
      return err(searchFailure('file search', result.error));
    }

    const matches = result.value.items.map((item, index) => ({
      path: normalizePath(item.relativePath),
      score: result.value.scores[index]?.total ?? 0,
      indices: fileSearchHighlightIndices(item.relativePath, query),
    }));
    const truncated = result.value.totalMatched > matches.length;
    recordSearchOperation({
      operation: 'file-search',
      status: 'ok',
      startedAt,
      cwdId: this.cwdId,
      resultCount: matches.length,
      indexedCount: result.value.totalFiles,
      truncated,
    });
    return ok({
      matches,
      total: result.value.totalMatched,
      truncated,
      indexedFiles: result.value.totalFiles,
    });
  }

  searchText(options: ProjectTextSearchOptions): ResultAsync<ProjectTextSearchResult, DomainError> {
    return ResultAsync.fromSafePromise(this.searchTextImpl(options)).andThen((result) => result);
  }

  private async searchTextImpl(
    options: ProjectTextSearchOptions,
  ): Promise<Result<ProjectTextSearchResult, DomainError>> {
    const startedAt = performance.now();
    const query = options.query;
    if (!query.trim()) {
      recordSearchOperation({
        operation: 'text-search',
        status: 'error',
        startedAt,
        cwdId: this.cwdId,
        errorCategory: 'validation',
      });
      return err(badRequest('query is required'));
    }
    const maxResults = Math.max(
      1,
      Math.min(MAX_RESULTS, options.maxResults ?? DEFAULT_MAX_RESULTS),
    );
    const source = options.regex ? query : escapeRegex(query);
    // Match ripgrep's existing --smart-case behavior unless the caller
    // explicitly requests case sensitivity. FFF does not expose whole-word
    // matching, so qualifying native byte ranges are filtered below.
    const caseSensitive = options.caseSensitive || hasUppercase(query);
    const translatedQuery = caseSensitive ? source : `(?i:${source})`;
    const constraints = buildConstraints(options.include, options.exclude);
    const groups = constraints.includes.length > 0 ? constraints.includes : [''];
    const byIdentity = new Map<string, ReturnType<typeof normalizeGrepMatch>>();
    const collectionLimit = maxResults + 1;

    for (const include of groups) {
      let cursor: GrepCursor | null = null;
      do {
        const constrainedQuery = [include, ...constraints.excludes, translatedQuery]
          .filter(Boolean)
          .join(' ');
        const result = this.finder.grep(constrainedQuery, {
          mode: 'regex',
          smartCase: false,
          cursor,
          pageSize: collectionLimit,
          maxMatchesPerFile: collectionLimit,
        });
        if (!result.ok) {
          recordSearchOperation({
            operation: 'text-search',
            status: 'error',
            startedAt,
            cwdId: this.cwdId,
            errorCategory: 'query',
          });
          return err(searchFailure('content search', result.error));
        }
        if (result.value.regexFallbackError) {
          recordSearchOperation({
            operation: 'text-search',
            status: 'error',
            startedAt,
            cwdId: this.cwdId,
            errorCategory: 'validation',
          });
          return err(badRequest(`Invalid regular expression: ${result.value.regexFallbackError}`));
        }
        for (const match of result.value.items) {
          const normalized = normalizeGrepMatch(match, options.wholeWord ?? false);
          if (normalized.ranges.length === 0) continue;
          const id = `${normalized.path}:${normalized.line}:${JSON.stringify(normalized.ranges)}`;
          byIdentity.set(id, normalized);
          if (byIdentity.size >= collectionLimit) break;
        }
        cursor = result.value.nextCursor;
        if (byIdentity.size >= collectionLimit) break;
      } while (cursor);
      if (byIdentity.size >= collectionLimit) break;
    }

    const normalizedMatches = [...byIdentity.values()].slice(0, maxResults);
    const truncated = byIdentity.size > maxResults;
    const filesByPath = new Map<string, ProjectTextFileResult>();
    for (const match of normalizedMatches) {
      const file = filesByPath.get(match.path) ?? { path: match.path, matches: [] };
      file.matches.push({ line: match.line, text: match.text, ranges: match.ranges });
      filesByPath.set(match.path, file);
    }
    const durationMs = Math.round(performance.now() - startedAt);
    recordSearchOperation({
      operation: 'text-search',
      status: 'ok',
      startedAt,
      cwdId: this.cwdId,
      resultCount: normalizedMatches.length,
      indexedCount: this.health().indexedFiles,
      truncated,
    });
    return ok({
      files: [...filesByPath.values()],
      totalMatches: normalizedMatches.length,
      truncated,
      durationMs,
    });
  }

  trackSelection(query: string, relativePath: string): Result<void, DomainError> {
    const startedAt = performance.now();
    const result = this.finder.trackQuery(query, relativePath);
    recordSearchOperation({
      operation: 'selection-tracking',
      status: result.ok ? 'ok' : 'error',
      startedAt,
      cwdId: this.cwdId,
      ...(result.ok ? {} : { errorCategory: 'query' as const }),
    });
    return result.ok ? ok(undefined) : err(searchFailure('selection tracking', result.error));
  }

  refreshGitStatus(): Result<void, DomainError> {
    const startedAt = performance.now();
    const result = this.finder.refreshGitStatus();
    recordSearchOperation({
      operation: 'git-refresh',
      status: result.ok ? 'ok' : 'error',
      startedAt,
      cwdId: this.cwdId,
      ...(result.ok ? {} : { errorCategory: 'query' as const }),
    });
    return result.ok ? ok(undefined) : err(searchFailure('Git refresh', result.error));
  }

  rescan(): ResultAsync<void, DomainError> {
    const startedAt = performance.now();
    const started = this.finder.scanFiles();
    if (!started.ok) {
      recordSearchOperation({
        operation: 'rescan',
        status: 'error',
        startedAt,
        cwdId: this.cwdId,
        errorCategory: 'scan',
      });
      return ResultAsync.fromPromise(Promise.reject(started.error), () =>
        searchFailure('rescan', started.error),
      );
    }
    this.revision += 1;
    return ResultAsync.fromPromise(this.finder.waitForScan(30_000), (cause) =>
      searchFailure('rescan', safeReason(cause)),
    )
      .andThen((ready) =>
        ready.ok && ready.value
          ? ok(undefined)
          : err(searchFailure('rescan', ready.ok ? 'timed out' : ready.error)),
      )
      .map((value) => {
        recordSearchOperation({
          operation: 'rescan',
          status: 'ok',
          startedAt,
          cwdId: this.cwdId,
          indexedCount: this.health().indexedFiles,
        });
        return value;
      })
      .mapErr((error) => {
        recordSearchOperation({
          operation: 'rescan',
          status: 'error',
          startedAt,
          cwdId: this.cwdId,
          errorCategory: 'scan',
        });
        return error;
      });
  }

  health(): ProjectSearchHealth {
    if (this.disposed) {
      return {
        available: false,
        version: null,
        scanState: 'disposed',
        indexedFiles: 0,
        watcherReady: false,
      };
    }
    const health = this.finder.healthCheck();
    if (!health.ok) {
      return {
        available: false,
        version: null,
        scanState: 'failed',
        indexedFiles: 0,
        watcherReady: false,
        failureReason: 'health-check',
      };
    }
    const progress = this.finder.getScanProgress();
    if (!progress.ok) {
      return {
        available: false,
        version: health.value.version,
        scanState: 'failed',
        indexedFiles: 0,
        watcherReady: false,
        failureReason: 'scan-progress',
      };
    }
    return {
      available: health.value.filePicker.initialized,
      version: health.value.version,
      scanState: progress.value.isScanning ? 'scanning' : 'ready',
      indexedFiles: progress.value.scannedFilesCount,
      watcherReady: progress.value.isWatcherReady,
      ...(health.value.filePicker.error ? { failureReason: 'file-picker' } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.finder.destroy();
  }
}

function buildConstraints(include: string | undefined, exclude: string | undefined) {
  return {
    includes: splitGlobs(include),
    excludes: splitGlobs(exclude).map((glob) => (glob.startsWith('!') ? glob : `!${glob}`)),
  };
}

function splitGlobs(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGrepMatch(
  match: {
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    matchRanges: [number, number][];
  },
  wholeWord: boolean,
) {
  const ranges = wholeWord
    ? match.matchRanges.filter((range) => isWholeWordRange(match.lineContent, range))
    : match.matchRanges;
  return {
    path: normalizePath(match.relativePath),
    line: match.lineNumber,
    text: match.lineContent.replace(/\r?\n$/, ''),
    ranges: ranges.map(([start, end]) => ({ start, end })),
  };
}

function isWholeWordRange(text: string, [start, end]: [number, number]): boolean {
  const bytes = Buffer.from(text);
  const before = bytes.subarray(0, start).toString('utf8');
  const after = bytes.subarray(end).toString('utf8');
  const previous = Array.from(before).at(-1);
  const next = Array.from(after)[0];
  return !isWordCharacter(previous) && !isWordCharacter(next);
}

function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    /[\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\u200C\u200D]/u.test(
      character,
    )
  );
}

function hasUppercase(value: string): boolean {
  return value.toLocaleLowerCase() !== value;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchFailure(operation: string, reason: string): DomainError {
  return internal(`Search ${operation} failed: ${safeReason(reason)}`);
}

function unavailableFailure(reason: unknown): DomainError {
  const sanitized = safeReason(reason);
  return internal(`Search unavailable: ${sanitized}`);
}

function initializationErrorCategory(reason: unknown): SearchErrorCategory {
  return reason instanceof FffInitializationError ? reason.category : 'initialization';
}

function safeReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

interface SearchOperationRecord {
  operation: SearchOperation;
  status: 'ok' | 'error';
  startedAt: number;
  cwdId: string;
  resultCount?: number;
  indexedCount?: number;
  truncated?: boolean;
  errorCategory?: SearchErrorCategory;
}

function recordSearchOperation(record: SearchOperationRecord): void {
  const durationMs = Math.max(0, performance.now() - record.startedAt);
  const resultCount = record.resultCount ?? 0;
  const indexedCount = record.indexedCount ?? 0;
  const truncated = record.truncated ?? false;
  const attributes = {
    operation: record.operation,
    status: record.status,
    truncated,
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  };

  metric('search.fff.operations', 1, { attributes });
  recordHistogram('search.fff.duration_ms', durationMs, { unit: 'ms', attributes });
  metric('search.fff.result_count', resultCount, { type: 'gauge', attributes });
  metric('search.fff.indexed_count', indexedCount, { type: 'gauge', attributes });
  metric('search.fff.truncated', truncated ? 1 : 0, { type: 'gauge', attributes });

  const metadata = {
    namespace: NS,
    cwdId: record.cwdId,
    operation: record.operation,
    status: record.status,
    durationMs: Math.round(durationMs),
    resultCount,
    indexedCount,
    truncated,
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  };
  if (record.status === 'ok') {
    log.info('FFF operation completed', metadata);
  } else {
    log.warn('FFF operation failed', metadata);
  }
}

function safeCwdId(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}
