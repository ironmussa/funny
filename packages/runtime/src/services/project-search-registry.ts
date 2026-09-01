/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 * @domain consumes: git:changed, git:pulled, git:checkout, git:reverted, git:revert, git:reset-hard, git:stash-popped
 */

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { internal, type DomainError } from '@funny/shared/errors';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import {
  createFffProjectSearchProvider,
  getFffNativeHealth,
  type FffProviderOptions,
} from './fff-project-search-provider.js';
import type {
  ProjectSearchFailureReason,
  ProjectSearchHealth,
  ProjectSearchProvider,
} from './project-search-provider.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { threadEventBus } from './thread-event-bus.js';

const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 8;

type ProviderFactory = (
  cwd: string,
  options: FffProviderOptions,
) => ResultAsync<ProjectSearchProvider, DomainError>;

interface RegistryEntry {
  canonicalCwd: string;
  initialization: Promise<Result<ProjectSearchProvider, DomainError>>;
  provider: ProjectSearchProvider | null;
  activeRequests: number;
  lastUsedAt: number;
  disposeWhenIdle: boolean;
}

export interface ProjectSearchRegistryOptions {
  dataDir?: string;
  scopeKey?: string;
  idleTtlMs?: number;
  maxEntries?: number;
  providerFactory?: ProviderFactory;
  now?: () => number;
  /** Disable only in deterministic tests; production always has an idle sweep. */
  sweepIntervalMs?: number | false;
}

export interface ProjectSearchLease {
  provider: ProjectSearchProvider;
  release(): void;
}

export interface ProjectSearchRegistryStats {
  residentEntries: number;
  activeRequests: number;
  initializingEntries: number;
}

export interface ProjectSearchDiagnosticEntry extends ProjectSearchHealth {
  cwdId: string;
  activeRequests: number;
}

export interface ProjectSearchRegistryDiagnostics extends ProjectSearchRegistryStats {
  native: ReturnType<typeof getFffNativeHealth>;
  entries: ProjectSearchDiagnosticEntry[];
  lastInitializationFailure?: {
    cwdId: string;
    reason: ProjectSearchFailureReason;
  };
}

export class ProjectSearchRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly dataDir: string;
  private readonly scopeKey: string;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly providerFactory: ProviderFactory;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;
  private lastInitializationFailure:
    | { cwdId: string; reason: ProjectSearchFailureReason }
    | undefined;

  constructor(options: ProjectSearchRegistryOptions = {}) {
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.scopeKey = options.scopeKey ?? process.env.FUNNY_RUNNER_ID ?? process.env.USER ?? 'local';
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.providerFactory = options.providerFactory ?? createFffProjectSearchProvider;
    this.now = options.now ?? Date.now;

    const sweepIntervalMs =
      options.sweepIntervalMs === false
        ? false
        : (options.sweepIntervalMs ?? Math.max(1_000, Math.min(60_000, this.idleTtlMs / 2)));
    this.sweepTimer =
      sweepIntervalMs === false ? null : setInterval(() => this.evictIdle(), sweepIntervalMs);
    this.sweepTimer?.unref?.();
  }

  acquire(cwd: string): ResultAsync<ProjectSearchLease, DomainError> {
    return ResultAsync.fromPromise(this.acquireImpl(cwd), (cause) =>
      internal(`Search registry failed: ${safeReason(cause)}`),
    ).andThen((result) => result);
  }

  private async acquireImpl(cwd: string): Promise<Result<ProjectSearchLease, DomainError>> {
    const canonical = await realpath(cwd);
    let entry = this.entries.get(canonical);

    if (!entry) {
      this.evictForCapacity(this.maxEntries - 1);
      if (this.entries.size >= this.maxEntries) {
        return err(internal('Search capacity reached; all resident indexes are active'));
      }

      const paths = searchStatePaths(this.dataDir, this.scopeKey, canonical);
      entry = {
        canonicalCwd: canonical,
        initialization: this.initializeProvider(canonical, paths),
        provider: null,
        activeRequests: 0,
        lastUsedAt: this.now(),
        disposeWhenIdle: false,
      };
      this.entries.set(canonical, entry);
    }

    entry.activeRequests += 1;
    entry.lastUsedAt = this.now();
    const initialized = await entry.initialization;
    if (initialized.isErr()) {
      this.lastInitializationFailure = {
        cwdId: stableHash(canonical).slice(0, 16),
        reason: initializationFailureReason(initialized.error),
      };
      this.releaseEntry(entry);
      if (this.entries.get(canonical) === entry) this.entries.delete(canonical);
      return err(initialized.error);
    }

    entry.provider = initialized.value;
    let released = false;
    return ok({
      provider: initialized.value,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(entry);
      },
    });
  }

  private async initializeProvider(
    canonicalCwd: string,
    paths: ReturnType<typeof searchStatePaths>,
  ): Promise<Result<ProjectSearchProvider, DomainError>> {
    try {
      return await this.providerFactory(canonicalCwd, {
        frecencyDbPath: paths.frecencyDbPath,
        historyDbPath: paths.historyDbPath,
      });
    } catch (cause) {
      return err(internal(`Search registry failed: ${safeReason(cause)}`));
    }
  }

  /** Refresh an already-resident entry without initializing a new backend. */
  refreshExisting(cwd: string, mode: 'git-status' | 'rescan'): ResultAsync<boolean, DomainError> {
    return ResultAsync.fromPromise(this.refreshExistingImpl(cwd, mode), (cause) =>
      internal(`Search refresh failed: ${safeReason(cause)}`),
    ).andThen((result) => result);
  }

  private async refreshExistingImpl(
    cwd: string,
    mode: 'git-status' | 'rescan',
  ): Promise<Result<boolean, DomainError>> {
    const canonical = await canonicalPathIfPresent(cwd);
    if (!canonical) return ok(false);
    const entry = this.entries.get(canonical);
    if (!entry || entry.disposeWhenIdle) return ok(false);

    entry.activeRequests += 1;
    entry.lastUsedAt = this.now();
    try {
      const initialized = await entry.initialization;
      if (initialized.isErr()) return err(initialized.error);
      entry.provider = initialized.value;
      const refreshed =
        mode === 'rescan' ? await initialized.value.rescan() : initialized.value.refreshGitStatus();
      return refreshed.map(() => true);
    } finally {
      this.releaseEntry(entry);
    }
  }

  invalidate(cwd: string): ResultAsync<boolean, DomainError> {
    return ResultAsync.fromPromise(this.invalidateImpl(cwd), (cause) =>
      internal(`Search invalidation failed: ${safeReason(cause)}`),
    );
  }

  private async invalidateImpl(cwd: string): Promise<boolean> {
    const canonical = await canonicalPathIfPresent(cwd);
    if (!canonical) return false;
    const entry = this.entries.get(canonical);
    if (!entry) return false;
    entry.disposeWhenIdle = true;
    if (entry.activeRequests === 0) this.disposeEntry(entry);
    return true;
  }

  evictIdle(at = this.now()): void {
    for (const entry of this.entries.values()) {
      if (entry.activeRequests === 0 && at - entry.lastUsedAt >= this.idleTtlMs) {
        this.disposeEntry(entry);
      }
    }
  }

  stats(): ProjectSearchRegistryStats {
    let activeRequests = 0;
    let initializingEntries = 0;
    for (const entry of this.entries.values()) {
      activeRequests += entry.activeRequests;
      if (!entry.provider) initializingEntries += 1;
    }
    return { residentEntries: this.entries.size, activeRequests, initializingEntries };
  }

  diagnostics(): ProjectSearchRegistryDiagnostics {
    const stats = this.stats();
    const entries = [...this.entries.values()].map<ProjectSearchDiagnosticEntry>((entry) => {
      const health = entry.provider?.health() ?? {
        available: false,
        version: null,
        scanState: 'initializing' as const,
        indexedFiles: 0,
        watcherReady: false,
      };
      return {
        cwdId: stableHash(entry.canonicalCwd).slice(0, 16),
        activeRequests: entry.activeRequests,
        ...health,
      };
    });
    return {
      ...stats,
      native: getFffNativeHealth(),
      entries,
      ...(this.lastInitializationFailure
        ? { lastInitializationFailure: this.lastInitializationFailure }
        : {}),
    };
  }

  async disposeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const initialized = await entry.initialization;
        if (initialized.isOk()) initialized.value.dispose();
      }),
    );
  }

  private releaseEntry(entry: RegistryEntry): void {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastUsedAt = this.now();
    if (entry.activeRequests === 0 && entry.disposeWhenIdle) {
      this.disposeEntry(entry);
      return;
    }
    this.evictForCapacity(this.maxEntries);
  }

  private evictForCapacity(targetSize: number): void {
    while (this.entries.size > targetSize) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.activeRequests === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!candidate) return;
      this.disposeEntry(candidate);
    }
  }

  private disposeEntry(entry: RegistryEntry): void {
    if (this.entries.get(entry.canonicalCwd) !== entry) return;
    this.entries.delete(entry.canonicalCwd);
    if (entry.provider) {
      entry.provider.dispose();
      return;
    }
    void entry.initialization.then((initialized) => {
      if (initialized.isOk()) initialized.value.dispose();
    });
  }
}

export function searchStatePaths(dataDir: string, scopeKey: string, canonicalCwd: string) {
  const scopeHash = stableHash(scopeKey);
  const cwdHash = stableHash(canonicalCwd);
  const stateDir = join(dataDir, 'search', scopeHash, cwdHash);
  return {
    stateDir,
    frecencyDbPath: join(stateDir, 'frecency.db'),
    historyDbPath: join(stateDir, 'history.db'),
  };
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function canonicalPathIfPresent(cwd: string): Promise<string | null> {
  try {
    return await realpath(cwd);
  } catch {
    const lexical = resolve(cwd);
    return lexical;
  }
}

function safeReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

function initializationFailureReason(error: DomainError): ProjectSearchFailureReason {
  const message = error.message.toLowerCase();
  if (message.includes('native binding')) return 'native-load';
  if (message.includes('initial scan')) return 'scan';
  return 'initialization';
}

function refreshFromEvent(cwd: string, mode: 'git-status' | 'rescan'): void {
  void projectSearchRegistry.refreshExisting(cwd, mode).match(
    () => undefined,
    (error) =>
      log.warn('FFF registry refresh failed', {
        namespace: 'fff-search',
        mode,
        reason: error.message,
      }),
  );
}

export const projectSearchRegistry = new ProjectSearchRegistry();

threadEventBus.on('git:changed', (event) => refreshFromEvent(event.cwd, 'git-status'));
threadEventBus.on('git:pulled', (event) => refreshFromEvent(event.cwd, 'rescan'));
threadEventBus.on('git:checkout', (event) => refreshFromEvent(event.cwd, 'rescan'));
threadEventBus.on('git:reverted', (event) => refreshFromEvent(event.cwd, 'rescan'));
threadEventBus.on('git:revert', (event) => refreshFromEvent(event.cwd, 'rescan'));
threadEventBus.on('git:reset-hard', (event) => refreshFromEvent(event.cwd, 'rescan'));
threadEventBus.on('git:stash-popped', (event) => refreshFromEvent(event.cwd, 'rescan'));

shutdownManager.register(
  'project-search-registry',
  () => projectSearchRegistry.disposeAll(),
  ShutdownPhase.SERVICES,
);
