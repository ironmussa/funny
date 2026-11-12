import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fetch before importing api
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Ensure __TAURI_INTERNALS__ is absent so we use /api base (jsdom default)
delete (window as any).__TAURI_INTERNALS__;

// Now import after mocks are set up
const { api } = await import('@/lib/api');
const { useCircuitBreakerStore } = await import('@/stores/circuit-breaker-store');
const { createClientLogger } = await import('@/lib/client-logger');

function mockJsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Reset circuit breaker so error tests don't affect subsequent tests
    useCircuitBreakerStore.setState({ state: 'closed', failureCount: 0, _cooldownTimer: null });
  });

  test('sends HTTP failure details to the Abbacchio client logger', async () => {
    const logError = vi.spyOn(createClientLogger('api'), 'error').mockImplementation(() => {});
    try {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ error: 'Could not determine remote URL for this project' }, 400),
      );
      const result = await api.listBranches('p1');
      expect(result.isErr()).toBe(true);
      expect(logError).toHaveBeenCalledWith(
        'API request failed',
        expect.objectContaining({
          kind: 'http',
          method: 'GET',
          path: '/projects/p1/branches',
          status: 400,
          error: 'Could not determine remote URL for this project',
          durationMs: expect.any(Number),
          traceparent: expect.any(String),
        }),
      );
    } finally {
      logError.mockRestore();
    }
  });

  describe('Projects', () => {
    test('listProjects is the projects.list tRPC query; null means personal', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ result: { data: [{ id: 'p1', name: 'Test' }] } }),
      );

      const result = await api.listProjects(null, 'te');
      expect(result._unsafeUnwrap()).toEqual([{ id: 'p1', name: 'Test' }]);
      const [url] = mockFetch.mock.calls.at(-1)!;
      expect(url).toContain('/api/trpc/projects.list?input=');
      expect(JSON.parse(decodeURIComponent(url.split('?input=')[1]))).toEqual({
        personal: true,
        q: 'te',
      });
    });

    test('createProject calls POST /api/projects', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'new', name: 'New' }, 201));

      const result = await api.createProject('New', '/path');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ id: 'new', name: 'New' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('deleteProject is the projects.remove tRPC mutation', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: { data: { ok: true } } }));

      const result = await api.deleteProject('p1');
      expect(result.isOk()).toBe(true);
      const [url, init] = mockFetch.mock.calls.at(-1)!;
      expect(url).toMatch(/\/api\/trpc\/projects\.remove$/);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ projectId: 'p1' });
    });

    test('listBranches calls GET /api/projects/:id/branches', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(['main', 'dev']));

      const result = await api.listBranches('p1');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(['main', 'dev']);
    });
  });

  describe('Circuit breaker', () => {
    test('runner proxy 502/504 responses do not open the server circuit', async () => {
      mockFetch
        .mockResolvedValueOnce(mockJsonResponse({ error: 'No runner connected' }, 502))
        .mockResolvedValueOnce(mockJsonResponse({ error: 'Runner timed out' }, 504))
        .mockResolvedValueOnce(mockJsonResponse({ error: 'Runner timed out' }, 504));

      await api.getGitStatuses('p1');
      await api.getGitStatuses('p1');
      await api.getGitStatuses('p1');

      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });

    test('central server 500 responses still open the server circuit', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ error: 'Internal server error' }, 500));

      await api.getGitStatuses('p1');
      await api.getGitStatuses('p1');
      await api.getGitStatuses('p1');

      expect(useCircuitBreakerStore.getState().state).toBe('open');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(3);
    });

    test('git diff read 500 responses stay scoped to the changes pane', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ error: 'Internal server error' }, 500));

      await api.getDiffSummary('t1');
      await api.getDiffSummary('t1');
      await api.getDiffSummary('t1');

      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });
  });

  describe('Threads', () => {
    // The server-answered thread reads and updates go over tRPC
    // (`/api/trpc/threads.*`, see api-trpc.test.ts); agent operations stay REST.
    const trpcInput = (url: string) => JSON.parse(decodeURIComponent(url.split('?input=')[1]));

    test('listThreads without projectId', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: { data: { threads: [] } } }));

      await api.listThreads();
      const [url] = mockFetch.mock.calls.at(-1)!;
      expect(url).toContain('/api/trpc/threads.list?input=');
      expect(trpcInput(url)).toEqual({});
    });

    test('listThreads with projectId', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: { data: { threads: [] } } }));

      await api.listThreads('p1');
      expect(trpcInput(mockFetch.mock.calls.at(-1)![0])).toEqual({ projectId: 'p1' });
    });

    test('getThread reads threads.get', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ result: { data: { id: 't1', title: 'Thread', messages: [] } } }),
      );

      const result = await api.getThread('t1');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().id).toBe('t1');
    });

    test('getThread includes scroll window hints', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ result: { data: { id: 't1', title: 'Thread', messages: [] } } }),
      );

      await api.getThread('t1', 50, undefined, {
        messageProgress: 0.25,
        messageAnchorId: 'm7',
      });

      expect(trpcInput(mockFetch.mock.calls.at(-1)![0])).toEqual({
        id: 't1',
        messageLimit: 50,
        messageProgress: 0.25,
        messageAnchorId: 'm7',
      });
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
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('sendMessage calls POST /api/threads/:id/message', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.sendMessage('t1', 'Hello');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1/message'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('stopThread calls POST /api/threads/:id/stop', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.stopThread('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1/stop'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('deleteThread calls DELETE /api/threads/:id', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.deleteThread('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/threads/t1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    test('archiveThread is the threads.update mutation', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ result: { data: { archived: true } } }));

      await api.archiveThread('t1', true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/trpc\/threads\.update$/),
        expect.objectContaining({ method: 'POST', body: '{"id":"t1","data":{"archived":true}}' }),
      );
    });
  });

  describe('Git', () => {
    test('getDiff calls GET /api/git/:threadId/diff', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse([]));

      await api.getDiff('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/diff'),
        expect.anything(),
      );
    });

    test('stageFiles calls POST /api/git/:threadId/stage', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.stageFiles('t1', ['file.ts']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/stage'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('commit calls POST /api/git/:threadId/commit', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.commit('t1', 'fix bug');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/commit'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('push calls POST /api/git/:threadId/push', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await api.push('t1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/push'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    test('createPR calls POST /api/git/:threadId/pr', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ ok: true, url: 'https://github.com/...' }),
      );

      await api.createPR('t1', 'PR title', 'PR body');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/git/t1/pr'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('Error handling', () => {
    test('returns err on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Not found' }, 404));

      const result = await api.getThread('nonexistent');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Not found');
      expect(result._unsafeUnwrapErr().type).toBe('NOT_FOUND');
    });

    test('returns err with generic message when response has no error field', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

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
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'Unauthorized' }, 401));

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('Unauthorized');
    });

    test('returns err on 503 Service Unavailable with empty body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }));

      const result = await api.listProjects();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toBe('HTTP 503');
    });

    test('handles response with Content-Type mismatch', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('<html>Error</html>', {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        }),
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

  describe('Agent Resources', () => {
    test('listAgentResources encodes provider, model, phase, projectPath, and projectId', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ provider: 'codex', resources: [], hidden: [] }),
      );

      const result = await api.listAgentResources({
        projectPath: '/tmp/p',
        projectId: 'project-1',
        provider: 'codex',
        model: 'gpt-5.5',
        phase: 'composer',
      });
      expect(result.isOk()).toBe(true);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/skills/resources?');
      expect(url).toContain('provider=codex');
      expect(url).toContain('model=gpt-5.5');
      expect(url).toContain('phase=composer');
      expect(url).toContain('projectPath=%2Ftmp%2Fp');
      expect(url).toContain('projectId=project-1');
    });

    test('listAgentResources omits the query string when no options given', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ provider: 'claude', resources: [], hidden: [] }),
      );

      await api.listAgentResources({});
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/skills/resources');
      expect(url).not.toContain('?');
    });
  });

  describe('MCP', () => {
    test('listMcpServers includes projectId when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ servers: [] }));

      const result = await api.listMcpServers('/tmp/p', 'claude', 'project-1');

      expect(result.isOk()).toBe(true);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/mcp/servers?');
      expect(url).toContain('projectPath=%2Ftmp%2Fp');
      expect(url).toContain('provider=claude');
      expect(url).toContain('projectId=project-1');
    });
  });
});
