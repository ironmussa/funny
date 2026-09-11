import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { scoreFilePath } from '@funny/shared/lib/file-search';
import { err, errAsync, ok, ResultAsync } from 'neverthrow';

import { walkDirectoryTree } from '../utils/git-files.js';
import type {
  ProjectSearchProvider,
  ProjectSearchHealth,
  ProjectFileMatch,
} from './project-search-provider.js';
import { TgrepContentSearch, type TgrepSearch } from './tgrep-content-search.js';

const executeFile = promisify(execFile);
export interface TgrepProviderOptions {
  stateDir: string;
  binary?: string;
  refreshIntervalMs?: number | false;
  createSearch?: () => TgrepSearch;
}

/** Git supplies file paths; the shared scorer ranks them. Content uses only tgrep. */
export function createTgrepProjectSearchProvider(
  cwd: string,
  options: TgrepProviderOptions,
): ResultAsync<ProjectSearchProvider, DomainError> {
  const provider = new TgrepProjectSearchProvider(cwd, options);
  return provider
    .rescan()
    .map(() => provider)
    .mapErr((error) => {
      provider.dispose();
      return error;
    });
}

class TgrepProjectSearchProvider implements ProjectSearchProvider {
  version = 0;
  private files: string[] = [];
  private disposed = false;
  private generation = 0;
  private search?: TgrepSearch;
  private fileRefresh?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private contentState: ProjectSearchHealth['scanState'] = 'initializing';
  private scanFailed = false;

  constructor(
    readonly cwd: string,
    private readonly options: TgrepProviderOptions,
  ) {
    if (options.refreshIntervalMs !== false) {
      this.timer = setInterval(() => {
        void this.refreshGitStatus();
      }, options.refreshIntervalMs ?? 2_000);
      this.timer.unref?.();
    }
  }

  listFiles() {
    if (this.disposed) return err(internal('Search provider disposed'));
    if (this.scanFailed) return err(internal('File scan unavailable'));
    return ok([...this.files]);
  }

  searchFiles(query: string, limit: number) {
    return this.listFiles().map((files) => {
      const needle = query.trim();
      const caseSensitive = needle !== needle.toLowerCase();
      const matches: ProjectFileMatch[] = [];
      for (const path of files) {
        const score = scoreFilePath(
          caseSensitive ? path : path.toLowerCase(),
          caseSensitive ? needle : needle.toLowerCase(),
          caseSensitive,
        );
        if (score) matches.push({ path, ...score });
      }
      matches.sort(
        (a, b) =>
          b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
      );
      const cap = Number.isFinite(limit) ? Math.max(1, Math.min(1_000, Math.floor(limit))) : 100;
      return {
        matches: matches.slice(0, cap),
        total: matches.length,
        truncated: matches.length > cap,
        indexedFiles: files.length,
      };
    });
  }

  trackSelection(_query: string, _relativePath: string) {
    return this.disposed ? err(internal('Search provider disposed')) : ok(undefined);
  }

  refreshGitStatus() {
    if (this.disposed) return err(internal('Search provider disposed'));
    void this.refreshFiles().catch(() => undefined);
    return ok(undefined);
  }

  rescan(): ResultAsync<void, DomainError> {
    if (this.disposed) return errAsync(internal('Search provider disposed'));
    this.generation++;
    this.search?.dispose();
    this.search = undefined;
    this.contentState = 'initializing';
    // Wait for an older file scan before requesting a fresh branch snapshot.
    const previous = this.fileRefresh;
    return ResultAsync.fromPromise(
      (async () => {
        await previous?.catch(() => undefined);
        if (this.disposed) throw new Error('disposed');
        await this.refreshFiles();
      })(),
      () => internal('File scan unavailable'),
    );
  }

  searchText(options: Parameters<ProjectSearchProvider['searchText']>[0]) {
    if (this.disposed) return errAsync(internal('Content search disposed'));
    if (!options.query.trim()) return errAsync(badRequest('query is required'));
    const current = this.generation;
    return ResultAsync.fromPromise(
      (async () => {
        this.search ??=
          this.options.createSearch?.() ??
          new TgrepContentSearch(
            this.cwd,
            this.options.binary ||
              process.env.FUNNY_TGREP_BINARY ||
              join(homedir(), '.local', 'bin', 'tgrep'),
            this.options.stateDir,
          );
        const search = this.search;
        try {
          const result = await search.search({ ...options });
          if (this.disposed || current !== this.generation) throw new Error('cancelled');
          this.contentState = 'ready';
          return result;
        } catch (error) {
          if (!this.disposed && current === this.generation && this.search === search) {
            this.contentState = 'failed';
            search.dispose();
            this.search = undefined;
            this.generation++;
          }
          throw error;
        }
      })(),
      () => internal('tgrep content search unavailable'),
    );
  }

  health(): ProjectSearchHealth {
    return {
      available: !this.disposed && !this.scanFailed && this.contentState === 'ready',
      version: this.contentState === 'ready' ? '1.0.5' : null,
      scanState: this.disposed ? 'disposed' : this.scanFailed ? 'failed' : this.contentState,
      indexedFiles: this.files.length,
      watcherReady: !this.disposed && this.contentState === 'ready',
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearInterval(this.timer);
    this.search?.dispose();
    this.files = [];
  }

  private refreshFiles(): Promise<void> {
    if (this.fileRefresh) return this.fileRefresh;
    this.fileRefresh = listProjectFiles(this.cwd)
      .then((files) => {
        if (this.disposed) return;
        if (files.length !== this.files.length || files.some((path, i) => path !== this.files[i])) {
          this.files = files;
          this.version++;
        }
        this.scanFailed = false;
      })
      .catch((error: unknown) => {
        this.scanFailed = true;
        throw error;
      })
      .finally(() => {
        this.fileRefresh = undefined;
      });
    return this.fileRefresh;
  }
}

async function listProjectFiles(cwd: string): Promise<string[]> {
  const commandOptions = { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  try {
    await executeFile('git', ['rev-parse', '--show-toplevel'], commandOptions);
  } catch {
    return walkDirectoryTree(cwd);
  }
  const result = await executeFile(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    commandOptions,
  );
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}
