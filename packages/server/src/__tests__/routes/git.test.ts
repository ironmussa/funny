import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { resolve } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';
import { executeSync } from '@funny/core/git';
import { getDiff, stageFiles, unstageFiles, commit } from '@funny/core/git';

const TEST_REPO = resolve(import.meta.dir, '..', '..', '..', '.test-tmp-git-routes');

function setupRepo() {
  rmSync(TEST_REPO, { recursive: true, force: true });
  mkdirSync(TEST_REPO, { recursive: true });
  executeSync('git', ['init'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO });
  executeSync('git', ['config', 'user.name', 'Test'], { cwd: TEST_REPO });
  writeFileSync(resolve(TEST_REPO, 'README.md'), '# Test');
  executeSync('git', ['add', '.'], { cwd: TEST_REPO });
  executeSync('git', ['commit', '-m', 'initial'], { cwd: TEST_REPO });
}

describe('Git Routes', () => {
  let app: Hono;
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    setupRepo();
  });

  afterAll(() => {
    rmSync(TEST_REPO, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDb = createTestDb();

    function resolveThreadCwd(threadId: string): string | null {
      const thread = testDb.db
        .select()
        .from(testDb.schema.threads)
        .where(eq(testDb.schema.threads.id, threadId))
        .get();
      if (!thread) return null;
      if (thread.worktreePath) return thread.worktreePath;
      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, thread.projectId))
        .get();
      return project?.path ?? null;
    }

    app = new Hono();

    // GET /:threadId/diff
    app.get('/:threadId/diff', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await getDiff(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json(result.value);
    });

    // POST /:threadId/stage
    app.post('/:threadId/stage', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const { paths } = await c.req.json<{ paths: string[] }>();
      const result = await stageFiles(cwd, paths);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true });
    });

    // POST /:threadId/commit
    app.post('/:threadId/commit', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const { message } = await c.req.json<{ message: string }>();
      const result = await commit(cwd, message);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });
  });

  test('GET /:threadId/diff returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/diff');
    expect(res.status).toBe(404);
  });

  test('GET /:threadId/diff returns diffs', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    // Create a change
    writeFileSync(resolve(TEST_REPO, 'route-test.txt'), 'new content');

    const res = await app.request('/t1/diff');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    // Clean up
    rmSync(resolve(TEST_REPO, 'route-test.txt'), { force: true });
  });

  test('POST /:threadId/stage returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/stage stages files', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    writeFileSync(resolve(TEST_REPO, 'to-stage.txt'), 'stage me');

    const res = await app.request('/t1/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['to-stage.txt'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Clean up: unstage and remove
    executeSync('git', ['restore', '--staged', 'to-stage.txt'], { cwd: TEST_REPO, reject: false });
    rmSync(resolve(TEST_REPO, 'to-stage.txt'), { force: true });
  });

  test('POST /:threadId/commit returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    expect(res.status).toBe(404);
  });
});
