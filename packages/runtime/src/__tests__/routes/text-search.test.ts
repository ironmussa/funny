import { Hono } from 'hono';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const { mockSearchText, mockRequireProjectPath } = vi.hoisted(() => ({
  mockSearchText: vi.fn(),
  mockRequireProjectPath: vi.fn(),
}));

vi.mock('../../services/text-search-service.js', () => ({
  searchText: mockSearchText,
}));

vi.mock('../../utils/path-scope.js', () => ({
  requireProjectPath: mockRequireProjectPath,
}));

import { textSearchRoutes } from '../../routes/text-search.js';

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
    mockSearchText.mockReset();
    mockRequireProjectPath.mockReset();
    mockRequireProjectPath.mockResolvedValue(null);
    mockSearchText.mockReturnValue(
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
  });

  test('searches an authorized project path without requiring a thread', async () => {
    const app = makeApp();
    const projectPath = '/tmp/funny-project';

    const res = await app.request(
      `/search/text?path=${encodeURIComponent(projectPath)}&q=flowchart`,
    );

    expect(res.status).toBe(200);
    expect(mockRequireProjectPath).toHaveBeenCalledWith(projectPath, 'user-1');
    expect(mockSearchText).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ query: 'flowchart' }),
    );
    const body = await res.json();
    expect(body.basePath).toBe(projectPath);
    expect(body.totalMatches).toBe(1);
  });

  test('requires either a thread id or project path', async () => {
    const app = makeApp();

    const res = await app.request('/search/text?q=flowchart');

    expect(res.status).toBe(400);
    expect(mockSearchText).not.toHaveBeenCalled();
  });

  test('denies project paths outside the user project scope', async () => {
    const app = makeApp();
    mockRequireProjectPath.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await app.request('/search/text?path=%2Fetc&q=flowchart');

    expect(res.status).toBe(403);
    expect(mockSearchText).not.toHaveBeenCalled();
  });
});
