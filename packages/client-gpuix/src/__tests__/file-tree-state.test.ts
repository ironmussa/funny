import { describe, expect, test } from 'bun:test';

import { createInMemoryPlatform } from '@funny/client-core/testing';

import {
  NATIVE_FILE_TREE_MAX_FILES,
  NativeFileTreeService,
  resolveNativeFileTreeTarget,
} from '../file-tree-state';

const project = { id: 'p1', path: '/repo' } as never;

describe('native file tree state', () => {
  test('prefers worktrees, uses project roots, and has no target without a directory', () => {
    expect(
      resolveNativeFileTreeTarget(
        { id: 't1', mode: 'worktree', worktreePath: '/worktrees/t1' } as never,
        project,
      ),
    ).toEqual({ path: '/worktrees/t1' });
    expect(
      resolveNativeFileTreeTarget({ id: 'scratch', mode: 'local', isScratch: true } as never),
    ).toBeNull();
    expect(
      resolveNativeFileTreeTarget({ id: 't3', mode: 'worktree' } as never, project),
    ).toBeNull();
    expect(resolveNativeFileTreeTarget({ id: 't2', mode: 'local' } as never, project)).toEqual({
      path: '/repo',
    });
  });

  test('lists files through the browse route the runtime serves', async () => {
    const host = createInMemoryPlatform({
      request: async () => ({
        status: 200,
        ok: true,
        headers: {},
        text: async () =>
          JSON.stringify({
            files: [
              { path: 'src/app.ts', type: 'file' },
              { path: 'src', type: 'folder' },
              'README.md',
            ],
            truncated: false,
          }),
      }),
    });
    const service = new NativeFileTreeService({
      platform: host.platform,
      clientOrigin: 'http://localhost:5173',
    });

    await service.loadForThread({ id: 't2', mode: 'local' } as never, project);

    expect(host.controls.requests[0]?.url).toContain(
      `/api/browse/files?path=%2Frepo&limit=${NATIVE_FILE_TREE_MAX_FILES}`,
    );
    expect(service.state.getState()).toMatchObject({
      basePath: '/repo',
      files: ['src/app.ts', 'README.md'],
      loading: false,
      loaded: true,
      truncated: false,
    });
  });

  test('marks threads without a directory as unavailable without calling the server', async () => {
    const host = createInMemoryPlatform();
    const service = new NativeFileTreeService({
      platform: host.platform,
      clientOrigin: 'http://localhost:5173',
    });

    await service.loadForThread({ id: 'scratch', mode: 'local', isScratch: true } as never);

    expect(host.controls.requests).toHaveLength(0);
    expect(service.state.getState()).toMatchObject({
      targetKey: null,
      unavailable: true,
      error: null,
    });
  });

  test('reports malformed responses without keeping the loading state active', async () => {
    const host = createInMemoryPlatform({
      request: async () => ({
        status: 200,
        ok: true,
        headers: {},
        text: async () => JSON.stringify({ files: 'wrong' }),
      }),
    });
    const service = new NativeFileTreeService({
      platform: host.platform,
      clientOrigin: 'http://localhost:5173',
    });

    await service.loadForThread({ id: 't2', mode: 'local' } as never, project);

    expect(service.state.getState()).toMatchObject({
      loading: false,
      error: 'File index response is invalid',
    });
    expect(host.controls.diagnostics).toHaveLength(1);
  });

  test('bounds very large repositories before publishing them to React', async () => {
    const files = Array.from(
      { length: NATIVE_FILE_TREE_MAX_FILES + 1 },
      (_, index) => `src/file-${index}.ts`,
    );
    const host = createInMemoryPlatform({
      request: async () => ({
        status: 200,
        ok: true,
        headers: {},
        text: async () => JSON.stringify({ files, truncated: true }),
      }),
    });
    const service = new NativeFileTreeService({
      platform: host.platform,
      clientOrigin: 'http://localhost:5173',
    });

    await service.loadForThread({ id: 't2', mode: 'local' } as never, project);

    expect(service.state.getState().files).toHaveLength(NATIVE_FILE_TREE_MAX_FILES);
    expect(service.state.getState().truncated).toBe(true);
  });
});
