import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { FileFinder } from '@ff-labs/fff-node';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const mocks = vi.hoisted(() => ({
  childProcessSpawn: vi.fn(),
  requireProjectPath: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.childProcessSpawn,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { getProject: vi.fn() } }),
}));

vi.mock('../../services/thread-manager.js', () => ({ getThread: vi.fn() }));

vi.mock('../../utils/path-scope.js', () => ({
  requireProjectPath: mocks.requireProjectPath,
}));

import { textSearchRoutes } from '../../routes/text-search.js';
import { projectSearchRegistry } from '../../services/project-search-registry.js';

const fixtureRoot = join('/tmp', `funny-search-route-failures-${process.pid}`);

function makeApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/search', textSearchRoutes);
  return app;
}

function fileSearchUrl(cwd: string) {
  return `/search/files?path=${encodeURIComponent(cwd)}&q=query`;
}

describe('FFF route failures', () => {
  beforeAll(() => mkdirSync(fixtureRoot, { recursive: true }));

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.requireProjectPath.mockResolvedValue(null);
    await projectSearchRegistry.disposeAll();
  });

  afterAll(async () => {
    await projectSearchRegistry.disposeAll();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('returns a controlled error when the native binding cannot load', async () => {
    vi.spyOn(FileFinder, 'ensureLoaded').mockImplementationOnce(() => {
      throw new Error('missing native test binding');
    });

    const response = await makeApp().request(fileSearchUrl(fixtureRoot));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('FFF native binding unavailable'),
    });
    expect(mocks.childProcessSpawn).not.toHaveBeenCalled();
  });

  test('returns a controlled error when FFF initialization fails', async () => {
    vi.spyOn(FileFinder, 'create').mockReturnValueOnce({
      ok: false,
      error: 'bad initialization',
    });

    const response = await makeApp().request(fileSearchUrl(fixtureRoot));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('FFF initialization failed'),
    });
    expect(mocks.childProcessSpawn).not.toHaveBeenCalled();
  });

  test('returns a controlled query error without invoking the ripgrep backend', async () => {
    const finder = {
      destroy: vi.fn(),
      fileSearch: vi.fn(() => ({ ok: false, error: 'native query failed' })),
      getScanProgress: vi.fn(() => ({
        ok: true,
        value: { isScanning: false, isWatcherReady: false, scannedFilesCount: 0 },
      })),
      healthCheck: vi.fn(() => ({
        ok: true,
        value: { version: 'test', filePicker: { initialized: true, error: null } },
      })),
      waitForScan: vi.fn(async () => ({ ok: true, value: true })),
      watch: vi.fn(() => ({ ok: false, error: 'watch unavailable' })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, 'create').mockReturnValueOnce({ ok: true, value: finder });

    const response = await makeApp().request(fileSearchUrl(fixtureRoot));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('native query failed'),
    });
    expect(finder.fileSearch).toHaveBeenCalledOnce();
    expect(mocks.childProcessSpawn).not.toHaveBeenCalled();
  });
});
