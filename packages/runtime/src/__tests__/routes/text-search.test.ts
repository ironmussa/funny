import { Hono } from 'hono';
import { ok, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  getProject: vi.fn(),
  getThread: vi.fn(),
  mkdirSync: vi.fn(),
  release: vi.fn(),
  requireProjectPath: vi.fn(),
  searchFiles: vi.fn(),
  searchText: vi.fn(),
  trackSelection: vi.fn(),
  diagnostics: vi.fn(),
}));

vi.mock('node:fs', () => ({ mkdirSync: mocks.mkdirSync }));

vi.mock('../../services/project-search-registry.js', () => ({
  projectSearchRegistry: { acquire: mocks.acquire, diagnostics: mocks.diagnostics },
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { getProject: mocks.getProject } }),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../utils/path-scope.js', () => ({
  requireProjectPath: mocks.requireProjectPath,
}));

import { textSearchRoutes } from '../../routes/text-search.js';
import { scratchPathFor } from '../../services/thread-context.js';

function makeApp(userId: string | null = 'user-1') {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId', userId);
    await next();
  });
  app.route('/search', textSearchRoutes);
  return app;
}

describe('text search routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockResolvedValue(null);
    mocks.getThread.mockResolvedValue(null);
    mocks.requireProjectPath.mockResolvedValue(null);
    mocks.searchText.mockReturnValue(
      okAsync({
        files: [
          {
            path: 'src/flowchart.ts',
            matches: [{ line: 1, text: 'flowchart', ranges: [{ start: 0, end: 9 }] }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        durationMs: 3,
      }),
    );
    mocks.searchFiles.mockReturnValue(
      ok({
        matches: [{ path: 'src/flowchart.ts', score: 42, indices: [4, 5, 6] }],
        total: 2,
        truncated: true,
        indexedFiles: 200,
      }),
    );
    mocks.trackSelection.mockReturnValue(ok(undefined));
    mocks.diagnostics.mockReturnValue({
      native: { available: true, version: '0.10.6' },
      residentEntries: 1,
      activeRequests: 0,
      initializingEntries: 0,
      entries: [
        {
          cwdId: '0123456789abcdef',
          activeRequests: 0,
          available: true,
          version: '0.10.6',
          scanState: 'ready',
          indexedFiles: 42,
          watcherReady: true,
        },
      ],
    });
    mocks.acquire.mockReturnValue(
      okAsync({
        provider: {
          searchFiles: mocks.searchFiles,
          searchText: mocks.searchText,
          trackSelection: mocks.trackSelection,
        },
        release: mocks.release,
      }),
    );
  });

  test('returns authenticated content-free backend diagnostics', async () => {
    const response = await makeApp().request('/search/health');

    expect(response.status).toBe(200);
    expect(mocks.diagnostics).toHaveBeenCalledOnce();
    expect(mocks.acquire).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      native: { available: true, version: '0.10.6' },
      residentEntries: 1,
      entries: [{ scanState: 'ready', indexedFiles: 42, watcherReady: true }],
    });
  });

  test('rejects unauthenticated backend diagnostics', async () => {
    const response = await makeApp(null).request('/search/health');

    expect(response.status).toBe(401);
    expect(mocks.diagnostics).not.toHaveBeenCalled();
  });

  test('returns ranked file matches with highlights, truncation, and base path', async () => {
    const app = makeApp();
    const projectPath = '/tmp/funny-project';

    const res = await app.request(
      `/search/files?path=${encodeURIComponent(projectPath)}&q=flt&limit=25`,
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectPath).toHaveBeenCalledWith(projectPath, 'user-1');
    expect(mocks.acquire).toHaveBeenCalledWith(projectPath);
    expect(mocks.searchFiles).toHaveBeenCalledWith('flt', 25);
    expect(mocks.trackSelection).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toEqual({
      matches: [{ path: 'src/flowchart.ts', score: 42, indices: [4, 5, 6] }],
      total: 2,
      truncated: true,
      indexedFiles: 200,
      basePath: projectPath,
    });
  });

  test('records a selection only through the explicit authorized selection endpoint', async () => {
    const projectPath = '/tmp/funny-project';
    const res = await makeApp().request('/search/files/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: projectPath,
        query: '  flt  ',
        relativePath: 'src/flowchart.ts',
      }),
    });

    expect(res.status).toBe(200);
    expect(mocks.requireProjectPath).toHaveBeenCalledWith(projectPath, 'user-1');
    expect(mocks.acquire).toHaveBeenCalledWith(projectPath);
    expect(mocks.trackSelection).toHaveBeenCalledWith('flt', 'src/flowchart.ts');
    expect(mocks.release).toHaveBeenCalledOnce();
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  test('rejects a denied selection scope before tracking or initializing FFF', async () => {
    mocks.requireProjectPath.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Access denied' }), { status: 403 }),
    );

    const res = await makeApp().request('/search/files/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc', query: 'flt', relativePath: 'passwd' }),
    });

    expect(res.status).toBe(403);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.trackSelection).not.toHaveBeenCalled();
  });

  test('resolves an owned worktree before initializing file search', async () => {
    mocks.getThread.mockResolvedValue({
      id: 'thread-worktree',
      isScratch: false,
      mode: 'worktree',
      projectId: 'project-1',
      userId: 'user-1',
      worktreePath: '/tmp/funny-worktree',
    });
    mocks.getProject.mockResolvedValue({ id: 'project-1', path: '/tmp/funny-project' });

    const res = await makeApp().request('/search/files?threadId=thread-worktree&q=flt');

    expect(res.status).toBe(200);
    expect(mocks.acquire).toHaveBeenCalledWith('/tmp/funny-worktree');
    expect(mocks.requireProjectPath).not.toHaveBeenCalled();
  });

  test('resolves an owned scratch cwd before initializing file search', async () => {
    mocks.getThread.mockResolvedValue({
      id: 'thread-scratch',
      isScratch: true,
      mode: 'local',
      projectId: null,
      userId: 'user-1',
      worktreePath: null,
    });
    const scratchPath = scratchPathFor('user-1', 'thread-scratch');

    const res = await makeApp().request('/search/files?threadId=thread-scratch&q=flt');

    expect(res.status).toBe(200);
    expect(mocks.mkdirSync).toHaveBeenCalledWith(scratchPath, { recursive: true });
    expect(mocks.acquire).toHaveBeenCalledWith(scratchPath);
  });

  test('rejects another user thread before initializing file search', async () => {
    mocks.getThread.mockResolvedValue({
      id: 'thread-other-user',
      isScratch: false,
      mode: 'worktree',
      projectId: 'project-1',
      userId: 'user-2',
      worktreePath: '/tmp/private-worktree',
    });

    const res = await makeApp().request('/search/files?threadId=thread-other-user&q=flt');

    expect(res.status).toBe(404);
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  test('rejects a denied project path before initializing file search', async () => {
    mocks.requireProjectPath.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await makeApp().request('/search/files?path=%2Fetc&q=flt');

    expect(res.status).toBe(403);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  test('searches an authorized project path without requiring a thread', async () => {
    const app = makeApp();
    const projectPath = '/tmp/funny-project';

    const res = await app.request(
      `/search/text?path=${encodeURIComponent(projectPath)}&q=flowchart`,
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectPath).toHaveBeenCalledWith(projectPath, 'user-1');
    expect(mocks.acquire).toHaveBeenCalledWith(projectPath);
    expect(mocks.searchText).toHaveBeenCalledWith(expect.objectContaining({ query: 'flowchart' }));
    expect(mocks.release).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.basePath).toBe(projectPath);
    expect(body.totalMatches).toBe(1);
  });

  test('requires either a thread id or project path', async () => {
    const app = makeApp();

    const res = await app.request('/search/text?q=flowchart');

    expect(res.status).toBe(400);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  test('denies project paths outside the user project scope', async () => {
    const app = makeApp();
    mocks.requireProjectPath.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await app.request('/search/text?path=%2Fetc&q=flowchart');

    expect(res.status).toBe(403);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});
