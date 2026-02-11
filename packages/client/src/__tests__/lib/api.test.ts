import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch before importing api
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock window.__TAURI_INTERNALS__ to ensure we use /api base
vi.stubGlobal('window', { ...globalThis.window });

// Now import after mocks are set up
const { api } = await import('@/lib/api');

function mockJsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Projects', () => {
    test('listProjects calls GET /api/projects', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([{ id: 'p1', name: 'Test' }]));

      const result = await api.listProjects();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([{ id: 'p1', name: 'Test' }]);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects'),
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
      );
    });

    test('createProject calls POST /api/projects', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'new', name: 'New' }, 201));

      const result = await api.createProject('New', '/path');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ id: 'new', name: 'New' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('deleteProject calls DELETE /api/projects/:id', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      const result = await api.deleteProject('p1');
      expect(result.isOk()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/p1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    test('listBranches calls GET /api/projects/:id/branches', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(['main', 'dev']));

      const result = await api.listBranches('p1');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(['main', 'dev']);
    });
  });

  describe('Threads', () => {
    test('listThreads without projectId', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

      await api.listThreads();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads'),
        expect.anything()
      );
    });

    test('listThreads with projectId', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

      await api.listThreads('p1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads?projectId=p1'),
        expect.anything()
      );
    });

    test('getThread calls GET /api/threads/:id', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ id: 't1', title: 'Thread', messages: [] })
      );

      const result = await api.getThread('t1');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe('t1');
    });

    test('createThread calls POST /api/threads', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 't1' }, 201));

      await api.createThread({
        projectId: 'p1',
        title: 'Test',
        mode: 'local',
        prompt: 'Do something',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('sendMessage calls POST /api/threads/:id/message', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.sendMessage('t1', 'Hello');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1/message'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('stopThread calls POST /api/threads/:id/stop', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.stopThread('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1/stop'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('deleteThread calls DELETE /api/threads/:id', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.deleteThread('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    test('archiveThread calls PATCH /api/threads/:id', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ archived: 1 }));

      await api.archiveThread('t1', true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  describe('Git', () => {
    test('getDiff calls GET /api/git/:threadId/diff', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

      await api.getDiff('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/diff'),
        expect.anything()
      );
    });

    test('stageFiles calls POST /api/git/:threadId/stage', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.stageFiles('t1', ['file.ts']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/stage'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('commit calls POST /api/git/:threadId/commit', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.commit('t1', 'fix bug');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/commit'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('push calls POST /api/git/:threadId/push', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.push('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/push'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('createPR calls POST /api/git/:threadId/pr', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, url: 'https://github.com/...' }));

      await api.createPR('t1', 'PR title', 'PR body');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/pr'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('Error handling', () => {
    test('returns err on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ error: 'Not found' }, 404)
      );

      const result = await api.getThread('nonexistent');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Not found');
      expect(result._unsafeUnwrapErr().type).toBe('NOT_FOUND');
    });

    test('returns err with generic message when response has no error field', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Server Error', { status: 500 })
      );

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('HTTP 500');
    });

    test('returns err on network failure (fetch rejects)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Failed to fetch');
    });

    test('returns err on 401 Unauthorized', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ error: 'Unauthorized' }, 401)
      );

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Unauthorized');
    });

    test('returns err on 503 Service Unavailable with empty body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 503 })
      );

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('HTTP 503');
    });

    test('handles response with Content-Type mismatch', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('<html>Error</html>', {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('HTTP 500');
    });
  });

  describe('Request body edge cases', () => {
    test('createThread sends all optional fields', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 't1' }, 201));

      await api.createThread({
        projectId: 'p1',
        title: 'Test',
        mode: 'worktree',
        model: 'opus',
        permissionMode: 'plan',
        baseBranch: 'feature/auth',
        prompt: 'Implement authentication',
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.model).toBe('opus');
      expect(body.permissionMode).toBe('plan');
      expect(body.baseBranch).toBe('feature/auth');
    });

    test('stageFiles sends array of paths', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.stageFiles('t1', ['file1.ts', 'file2.ts', 'file3.ts']);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.paths).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    });

    test('unstageFiles sends array of paths', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.unstageFiles('t1', ['file.ts']);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.paths).toEqual(['file.ts']);
    });

    test('revertFiles sends array of paths', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.revertFiles('t1', ['file.ts']);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.paths).toEqual(['file.ts']);
    });

    test('createPR sends title and body', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, url: 'https://...' }));

      await api.createPR('t1', 'Fix auth bug', 'Detailed description of changes');

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Fix auth bug');
      expect(body.body).toBe('Detailed description of changes');
    });
  });
});
