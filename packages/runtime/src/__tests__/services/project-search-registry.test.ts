import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { internal, type DomainError } from '@funny/shared/errors';
import { errAsync, ok, ResultAsync, type Result } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ProjectSearchHealth,
  ProjectSearchProvider,
} from '../../services/project-search-provider.js';
import {
  ProjectSearchRegistry,
  projectSearchRegistry,
  searchStatePaths,
} from '../../services/project-search-registry.js';
import { threadEventBus } from '../../services/thread-event-bus.js';

let root: string;
const registries: ProjectSearchRegistry[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'funny-search-registry-'));
});

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  rmSync(root, { recursive: true, force: true });
});

function fakeProvider(cwd: string): ProjectSearchProvider {
  const health: ProjectSearchHealth = {
    available: true,
    version: 'test',
    scanState: 'ready',
    indexedFiles: 0,
    watcherReady: true,
  };
  return {
    cwd,
    version: 1,
    listFiles: vi.fn(() => ok([])),
    searchFiles: vi.fn(() => ok({ matches: [], total: 0, truncated: false, indexedFiles: 0 })),
    searchText: vi.fn(() =>
      ResultAsync.fromSafePromise(
        Promise.resolve({ files: [], totalMatches: 0, truncated: false, durationMs: 0 }),
      ),
    ),
    trackSelection: vi.fn(() => ok(undefined)),
    refreshGitStatus: vi.fn(() => ok(undefined)),
    rescan: vi.fn(() => ResultAsync.fromSafePromise(Promise.resolve(undefined))),
    health: vi.fn(() => health),
    dispose: vi.fn(),
  };
}

function createRegistry(options: ConstructorParameters<typeof ProjectSearchRegistry>[0] = {}) {
  const registry = new ProjectSearchRegistry({ sweepIntervalMs: false, ...options });
  registries.push(registry);
  return registry;
}

function deferredResult<T>() {
  let resolve!: (result: Result<T, DomainError>) => void;
  const promise = new Promise<Result<T, DomainError>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ProjectSearchRegistry', () => {
  test('canonicalizes cwd and shares one concurrent initialization', async () => {
    const cwd = join(root, 'project');
    const alias = join(root, 'project-link');
    mkdirSync(cwd);
    symlinkSync(cwd, alias);
    const provider = fakeProvider(cwd);
    const pending = deferredResult<ProjectSearchProvider>();
    const factory = vi.fn(() =>
      ResultAsync.fromSafePromise(pending.promise).andThen((result) => result),
    );
    const registry = createRegistry({ providerFactory: factory });

    const first = registry.acquire(cwd);
    const second = registry.acquire(alias);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    pending.resolve(ok(provider));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.isOk()).toBe(true);
    expect(secondResult.isOk()).toBe(true);
    expect(firstResult._unsafeUnwrap().provider).toBe(provider);
    expect(secondResult._unsafeUnwrap().provider).toBe(provider);
    expect(registry.stats()).toEqual({
      residentEntries: 1,
      activeRequests: 2,
      initializingEntries: 0,
    });

    firstResult._unsafeUnwrap().release();
    secondResult._unsafeUnwrap().release();
  });

  test('evicts idle entries and the least-recently-used inactive entry', async () => {
    let now = 0;
    const providers = new Map<string, ProjectSearchProvider>();
    const registry = createRegistry({
      idleTtlMs: 50,
      maxEntries: 2,
      now: () => now,
      providerFactory: (cwd) => {
        const provider = fakeProvider(cwd);
        providers.set(cwd, provider);
        return ResultAsync.fromSafePromise(Promise.resolve(provider));
      },
    });
    const firstCwd = join(root, 'first');
    const secondCwd = join(root, 'second');
    const thirdCwd = join(root, 'third');
    mkdirSync(firstCwd);
    mkdirSync(secondCwd);
    mkdirSync(thirdCwd);

    const first = (await registry.acquire(firstCwd))._unsafeUnwrap();
    now = 1;
    first.release();
    const second = (await registry.acquire(secondCwd))._unsafeUnwrap();
    now = 2;
    second.release();
    now = 3;
    const third = (await registry.acquire(thirdCwd))._unsafeUnwrap();

    expect(providers.get(firstCwd)?.dispose).toHaveBeenCalledOnce();
    expect(providers.get(secondCwd)?.dispose).not.toHaveBeenCalled();
    third.release();
    now = 100;
    registry.evictIdle();
    expect(providers.get(secondCwd)?.dispose).toHaveBeenCalledOnce();
    expect(providers.get(thirdCwd)?.dispose).toHaveBeenCalledOnce();
    expect(registry.stats().residentEntries).toBe(0);
  });

  test('does not evict or invalidate an entry until its active lease is released', async () => {
    const cwd = join(root, 'worktree');
    const otherCwd = join(root, 'other');
    mkdirSync(cwd);
    mkdirSync(otherCwd);
    const provider = fakeProvider(cwd);
    const registry = createRegistry({
      idleTtlMs: 0,
      maxEntries: 1,
      providerFactory: (requestedCwd) =>
        ResultAsync.fromSafePromise(
          Promise.resolve(requestedCwd === cwd ? provider : fakeProvider(requestedCwd)),
        ),
    });
    const lease = (await registry.acquire(cwd))._unsafeUnwrap();

    registry.evictIdle();
    expect(provider.dispose).not.toHaveBeenCalled();
    const atCapacity = await registry.acquire(otherCwd);
    expect(atCapacity.isErr()).toBe(true);
    expect(atCapacity._unsafeUnwrapErr().message).toContain('capacity');
    expect((await registry.invalidate(cwd))._unsafeUnwrap()).toBe(true);
    expect(provider.dispose).not.toHaveBeenCalled();

    lease.release();
    expect(provider.dispose).toHaveBeenCalledOnce();
    expect(registry.stats().residentEntries).toBe(0);
  });

  test('isolates state by canonical cwd and runner scope', () => {
    const first = searchStatePaths('/data', 'runner-a', '/repo/one');
    const secondCwd = searchStatePaths('/data', 'runner-a', '/repo/two');
    const secondScope = searchStatePaths('/data', 'runner-b', '/repo/one');

    expect(first.stateDir).not.toBe(secondCwd.stateDir);
    expect(first.stateDir).not.toBe(secondScope.stateDir);
    expect(first.stateDir).not.toContain('runner-a');
    expect(first.stateDir).not.toContain('/repo/one');
    expect(first.frecencyDbPath).toBe(join(first.stateDir, 'frecency.db'));
    expect(first.historyDbPath).toBe(join(first.stateDir, 'history.db'));
  });

  test('refreshes Git status, rescans branch changes, and skips absent entries', async () => {
    const cwd = join(root, 'project');
    const absent = join(root, 'absent');
    mkdirSync(cwd);
    const provider = fakeProvider(cwd);
    const registry = createRegistry({
      providerFactory: () => ResultAsync.fromSafePromise(Promise.resolve(provider)),
    });
    const lease = (await registry.acquire(cwd))._unsafeUnwrap();
    lease.release();

    expect((await registry.refreshExisting(cwd, 'git-status'))._unsafeUnwrap()).toBe(true);
    expect(provider.refreshGitStatus).toHaveBeenCalledOnce();
    expect((await registry.refreshExisting(cwd, 'rescan'))._unsafeUnwrap()).toBe(true);
    expect(provider.rescan).toHaveBeenCalledOnce();
    expect((await registry.refreshExisting(absent, 'rescan'))._unsafeUnwrap()).toBe(false);
  });

  test('wires Git events to status refreshes and rescans', () => {
    const refresh = vi
      .spyOn(projectSearchRegistry, 'refreshExisting')
      .mockReturnValue(ResultAsync.fromSafePromise(Promise.resolve(true)));
    const base = { threadId: 'thread', userId: 'user', projectId: 'project', cwd: root };

    threadEventBus.emit('git:changed', { ...base, toolName: 'write' });
    threadEventBus.emit('git:pulled', { ...base, output: '' });
    threadEventBus.emit('git:checkout', { ...base, hash: 'abc', output: '' });
    threadEventBus.emit('git:reverted', { ...base, paths: ['file.ts'] });
    threadEventBus.emit('git:revert', { ...base, hash: 'abc', output: '' });
    threadEventBus.emit('git:reset-hard', { ...base, hash: 'abc', output: '' });
    threadEventBus.emit('git:stash-popped', { ...base, output: '' });

    expect(refresh.mock.calls).toEqual([
      [root, 'git-status'],
      [root, 'rescan'],
      [root, 'rescan'],
      [root, 'rescan'],
      [root, 'rescan'],
      [root, 'rescan'],
      [root, 'rescan'],
    ]);
  });

  test('disposes every resident provider during shutdown cleanup', async () => {
    const firstCwd = join(root, 'first');
    const secondCwd = join(root, 'second');
    mkdirSync(firstCwd);
    mkdirSync(secondCwd);
    const providers: ProjectSearchProvider[] = [];
    const registry = createRegistry({
      providerFactory: (cwd) => {
        const provider = fakeProvider(cwd);
        providers.push(provider);
        return ResultAsync.fromSafePromise(Promise.resolve(provider));
      },
    });
    (await registry.acquire(firstCwd))._unsafeUnwrap().release();
    (await registry.acquire(secondCwd))._unsafeUnwrap().release();

    await registry.disposeAll();

    expect(providers).toHaveLength(2);
    expect(providers[0]?.dispose).toHaveBeenCalledOnce();
    expect(providers[1]?.dispose).toHaveBeenCalledOnce();
    expect(registry.stats().residentEntries).toBe(0);
  });

  test('removes failed initialization so a later request can retry', async () => {
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const provider = fakeProvider(cwd);
    const factory = vi
      .fn()
      .mockImplementationOnce(() =>
        ResultAsync.fromSafePromise(Promise.reject(new Error('native load'))),
      )
      .mockImplementationOnce(() => ResultAsync.fromSafePromise(Promise.resolve(provider)));
    const registry = createRegistry({ providerFactory: factory });

    const failed = await registry.acquire(cwd);
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr()).toEqual(internal('Search registry failed: native load'));
    const retried = await registry.acquire(cwd);
    expect(retried.isOk()).toBe(true);
    retried._unsafeUnwrap().release();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('reports content-free resident diagnostics and a sanitized initialization failure', async () => {
    const cwd = join(root, 'private-project-name');
    mkdirSync(cwd);
    const provider = fakeProvider(cwd);
    const factory = vi
      .fn()
      .mockImplementationOnce(() =>
        errAsync(internal(`Search unavailable: FFF native binding unavailable at ${cwd}`)),
      )
      .mockImplementationOnce(() => ResultAsync.fromSafePromise(Promise.resolve(provider)));
    const registry = createRegistry({ providerFactory: factory });

    expect((await registry.acquire(cwd)).isErr()).toBe(true);
    const lease = (await registry.acquire(cwd))._unsafeUnwrap();
    const diagnostics = registry.diagnostics();
    lease.release();

    expect(diagnostics).toMatchObject({
      residentEntries: 1,
      activeRequests: 1,
      initializingEntries: 0,
      native: { available: expect.any(Boolean) },
      entries: [
        {
          cwdId: expect.stringMatching(/^[a-f0-9]{16}$/),
          available: true,
          scanState: 'ready',
          indexedFiles: 0,
          watcherReady: true,
          activeRequests: 1,
        },
      ],
      lastInitializationFailure: {
        cwdId: expect.stringMatching(/^[a-f0-9]{16}$/),
        reason: 'native-load',
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(cwd);
    expect(JSON.stringify(diagnostics)).not.toContain('native binding unavailable at');
  });

  test('reports initialization state without waiting for or duplicating provider creation', async () => {
    const cwd = join(root, 'initializing-project');
    mkdirSync(cwd);
    const provider = fakeProvider(cwd);
    const pending = deferredResult<ProjectSearchProvider>();
    const factory = vi.fn(() =>
      ResultAsync.fromSafePromise(pending.promise).andThen((result) => result),
    );
    const registry = createRegistry({ providerFactory: factory });

    const acquisition = registry.acquire(cwd);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());

    expect(registry.diagnostics()).toMatchObject({
      residentEntries: 1,
      activeRequests: 1,
      initializingEntries: 1,
      entries: [
        {
          cwdId: expect.stringMatching(/^[a-f0-9]{16}$/),
          available: false,
          scanState: 'initializing',
          indexedFiles: 0,
          watcherReady: false,
          activeRequests: 1,
        },
      ],
    });
    expect(factory).toHaveBeenCalledOnce();

    pending.resolve(ok(provider));
    const lease = (await acquisition)._unsafeUnwrap();
    lease.release();
  });
});
