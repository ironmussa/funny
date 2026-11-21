import { describe, test, expect, vi, beforeEach } from 'bun:test';

/**
 * Tests for the run-hook-command route behavior with neverthrow Result.
 * Re-creates a minimal route (same logic as git.ts) to avoid importing
 * the full runtime dependency chain.
 */
import { Hono } from 'hono';
import { ok, err } from 'neverthrow';

// Mock runHookCommand and listHooks
const mockRunHookCommand = vi.fn();
const mockListHooks = vi.fn();

// Minimal resultToResponse that mirrors the real one
function resultToResponse(c: any, result: any) {
  if (result.isErr()) {
    const error = result.error;
    // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
    const status = error.type === 'BAD_REQUEST' ? 400 : error.type === 'NOT_FOUND' ? 404 : 500;
    return c.json({ error: error.message }, status);
  }
  return c.json(result.value);
}

/**
 * Builds a minimal Hono app that mirrors the run-hook-command route logic
 * from git.ts, but without importing the full route module.
 */
function createTestApp() {
  const app = new Hono();

  app.post('/project/:projectId/run-hook-command', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const hookIndex = raw?.hookIndex;
    if (typeof hookIndex !== 'number') {
      return resultToResponse(c, err({ type: 'BAD_REQUEST', message: 'hookIndex is required' }));
    }
    const hooks = mockListHooks('/tmp/test-repo', 'pre-commit').filter((h: any) => h.enabled);
    if (hookIndex < 0 || hookIndex >= hooks.length) {
      return resultToResponse(
        c,
        err({ type: 'BAD_REQUEST', message: `Invalid hookIndex: ${hookIndex}` }),
      );
    }
    const hookResult = await mockRunHookCommand('/tmp/test-repo', hooks[hookIndex].command);
    if (hookResult.isErr()) return resultToResponse(c, hookResult);
    return c.json(hookResult.value);
  });

  return app;
}

describe('POST /project/:projectId/run-hook-command (neverthrow)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();

    mockListHooks.mockReturnValue([
      { command: 'eslint .', enabled: true },
      { command: 'prettier --check .', enabled: true },
      { command: 'disabled-hook', enabled: false },
    ]);
  });

  test('returns hook output when runHookCommand returns Ok with success', async () => {
    mockRunHookCommand.mockResolvedValue(ok({ success: true, output: 'All checks passed' }));

    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 0 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.output).toBe('All checks passed');
    expect(mockRunHookCommand).toHaveBeenCalledWith('/tmp/test-repo', 'eslint .');
  });

  test('returns hook output when runHookCommand returns Ok with failure', async () => {
    mockRunHookCommand.mockResolvedValue(
      ok({ success: false, output: 'error: 3 lint issues found' }),
    );

    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.output).toContain('lint issues');
    expect(mockRunHookCommand).toHaveBeenCalledWith('/tmp/test-repo', 'prettier --check .');
  });

  test('returns error response when runHookCommand returns Err', async () => {
    mockRunHookCommand.mockResolvedValue(
      err({
        type: 'PROCESS_ERROR',
        message: 'Hook command timed out after 120s',
        exitCode: 1,
        stderr: '',
      }),
    );

    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 0 }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('timed out');
  });

  test('returns 400 when hookIndex is missing', async () => {
    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('hookIndex');
  });

  test('returns 400 when hookIndex is out of range', async () => {
    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 99 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid hookIndex');
  });

  test('only counts enabled hooks for index resolution', async () => {
    mockRunHookCommand.mockResolvedValue(ok({ success: true, output: '' }));

    // hookIndex 1 -> second enabled hook (prettier), not the disabled one
    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 1 }),
    });

    expect(res.status).toBe(200);
    expect(mockRunHookCommand).toHaveBeenCalledWith('/tmp/test-repo', 'prettier --check .');
  });

  test('hookIndex 2 is out of range (only 2 enabled hooks)', async () => {
    const res = await app.request('/project/p1/run-hook-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookIndex: 2 }),
    });

    expect(res.status).toBe(400);
  });
});
