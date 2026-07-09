/**
 * Runtime-level Git orchestration. Low-level Git execution stays in
 * `@funny/core/git`; this service owns route-facing policy such as fetch
 * throttling, in-flight dedupe, and cache invalidation.
 */

import { fetchRemote, invalidateStatusCache, type GitIdentityOptions } from '@funny/core/git';
import type { DomainError } from '@funny/shared/errors';
import { ok, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';
import * as tm from './thread-manager.js';

export const gitStatusCache = new Map<string, { data: any; ts: number }>();
export const GIT_STATUS_CACHE_TTL_MS = 2_000;
export const FETCH_THROTTLE_MS = 30_000;

const lastFetchTs = new Map<string, number>();
const fetchInFlightByPath = new Set<string>();

export interface BackgroundFetchOptions {
  projectId: string;
  projectPath: string;
  identity?: GitIdentityOptions;
  attrs?: Record<string, string | number | boolean>;
  onFetched?: () => void | Promise<void>;
}

export interface ExplicitFetchOptions {
  cwd: string;
  identity?: GitIdentityOptions;
}

export class GitRuntimeService {
  scheduleBackgroundFetch(opts: BackgroundFetchOptions): boolean {
    const { projectId, projectPath, identity, attrs, onFetched } = opts;
    const lastFetch = lastFetchTs.get(projectId) ?? 0;
    if (Date.now() - lastFetch <= FETCH_THROTTLE_MS) return false;
    if (fetchInFlightByPath.has(projectPath)) return false;
    lastFetchTs.set(projectId, Date.now());
    fetchInFlightByPath.add(projectPath);

    const span = startSpan('git.fetch_remote', {
      attributes: { projectId, background: true, ...(attrs ?? {}) },
    });
    void fetchRemote(projectPath, identity).match(
      () => {
        span.end('ok');
        this.invalidateProjectStatus(projectId, projectPath);
        fetchInFlightByPath.delete(projectPath);
        void Promise.resolve(onFetched?.()).catch((err) => {
          log.warn('Background fetch onFetched callback failed', {
            namespace: 'git-service',
            projectId,
            error: String(err),
          });
        });
      },
      (error) => {
        span.end('error', error.message);
        fetchInFlightByPath.delete(projectPath);
        log.warn('Background git fetch failed', {
          namespace: 'git-service',
          projectId,
          error: error.message,
        });
      },
    );
    return true;
  }

  async fetchProject(
    projectId: string,
    opts: ExplicitFetchOptions,
  ): Promise<Result<boolean, DomainError>> {
    const result = await fetchRemote(opts.cwd, opts.identity);
    if (result.isErr()) return result;
    this.invalidateProjectStatus(projectId, opts.cwd);
    return ok(result.value);
  }

  async fetchThread(
    threadId: string,
    opts: ExplicitFetchOptions,
  ): Promise<Result<boolean, DomainError>> {
    const result = await fetchRemote(opts.cwd, opts.identity);
    if (result.isErr()) return result;
    invalidateStatusCache(opts.cwd);
    await this.invalidateThreadStatus(threadId);
    return ok(result.value);
  }

  invalidateProjectStatus(projectId: string, cwd?: string): void {
    gitStatusCache.delete(projectId);
    if (cwd) invalidateStatusCache(cwd);
  }

  async invalidateThreadStatus(threadId: string): Promise<void> {
    const thread = await tm.getThread(threadId);
    if (thread) gitStatusCache.delete(thread.projectId);
  }

  clearFetchStateForTests(): void {
    lastFetchTs.clear();
    fetchInFlightByPath.clear();
  }
}

export const gitRuntimeService = new GitRuntimeService();
