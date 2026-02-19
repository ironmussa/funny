import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { resolve } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';
import { executeSync } from '@funny/core/git';
import { getDiff, stageFiles, unstageFiles, commit, getLog, stash, stashPop, stashList, resetSoft, pull, revertFiles, addToGitignore } from '@funny/core/git';

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
      const { message, amend } = await c.req.json<{ message: string; amend?: boolean }>();
      const result = await commit(cwd, message, undefined, amend);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });

    // POST /:threadId/unstage
    app.post('/:threadId/unstage', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const { paths } = await c.req.json<{ paths: string[] }>();
      const result = await unstageFiles(cwd, paths);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true });
    });

    // POST /:threadId/revert
    app.post('/:threadId/revert', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const { paths } = await c.req.json<{ paths: string[] }>();
      const result = await revertFiles(cwd, paths);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true });
    });

    // GET /:threadId/log
    app.get('/:threadId/log', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const limitRaw = c.req.query('limit');
      const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 100) : 20;
      const result = await getLog(cwd, limit);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ entries: result.value });
    });

    // POST /:threadId/pull
    app.post('/:threadId/pull', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await pull(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });

    // POST /:threadId/stash
    app.post('/:threadId/stash', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await stash(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });

    // POST /:threadId/stash/pop
    app.post('/:threadId/stash/pop', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await stashPop(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });

    // GET /:threadId/stash/list
    app.get('/:threadId/stash/list', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await stashList(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ entries: result.value });
    });

    // POST /:threadId/reset-soft
    app.post('/:threadId/reset-soft', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const result = await resetSoft(cwd);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true, output: result.value });
    });

    // POST /:threadId/gitignore
    app.post('/:threadId/gitignore', async (c) => {
      const cwd = resolveThreadCwd(c.req.param('threadId'));
      if (!cwd) return c.json({ error: 'Thread not found' }, 404);
      const raw = await c.req.json().catch(() => ({}));
      const pattern = raw?.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return c.json({ error: 'pattern is required' }, 400);
      }
      const result = addToGitignore(cwd, pattern);
      if (result.isErr()) return c.json({ error: result.error.message }, 500);
      return c.json({ ok: true });
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

  test('POST /:threadId/commit creates a commit', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    writeFileSync(resolve(TEST_REPO, 'commit-route.txt'), 'commit me');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });

    const res = await app.request('/t1/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'route commit test' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('POST /:threadId/commit with amend', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    writeFileSync(resolve(TEST_REPO, 'amend-route.txt'), 'amend');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });

    const res = await app.request('/t1/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'amended via route', amend: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const log = executeSync('git', ['log', '-1', '--format=%s'], { cwd: TEST_REPO });
    expect(log.stdout.trim()).toBe('amended via route');
  });

  // ── Unstage / Revert routes ───────────────────────────────

  test('POST /:threadId/unstage returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/unstage unstages files', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    writeFileSync(resolve(TEST_REPO, 'unstage-me.txt'), 'content');
    executeSync('git', ['add', 'unstage-me.txt'], { cwd: TEST_REPO });

    const res = await app.request('/t1/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['unstage-me.txt'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Clean up
    rmSync(resolve(TEST_REPO, 'unstage-me.txt'), { force: true });
  });

  test('POST /:threadId/revert returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['file.txt'] }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/revert reverts changes', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    // Modify a tracked file
    writeFileSync(resolve(TEST_REPO, 'README.md'), '# Modified');

    const res = await app.request('/t1/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['README.md'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ── Log route ─────────────────────────────────────────────

  test('GET /:threadId/log returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/log');
    expect(res.status).toBe(404);
  });

  test('GET /:threadId/log returns commit entries', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1/log');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toBeDefined();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries[0].hash).toBeTruthy();
    expect(body.entries[0].message).toBeTruthy();
  });

  test('GET /:threadId/log respects limit query param', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1/log?limit=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(1);
  });

  // ── Pull route ────────────────────────────────────────────

  test('POST /:threadId/pull returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/pull', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/pull returns error when no remote', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1/pull', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  // ── Stash routes ──────────────────────────────────────────

  test('POST /:threadId/stash returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/stash', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/stash stashes changes', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    writeFileSync(resolve(TEST_REPO, 'stash-route.txt'), 'to stash');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });

    const res = await app.request('/t1/stash', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Pop stash to clean up
    executeSync('git', ['stash', 'pop'], { cwd: TEST_REPO, reject: false });
    rmSync(resolve(TEST_REPO, 'stash-route.txt'), { force: true });
  });

  test('GET /:threadId/stash/list returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/stash/list');
    expect(res.status).toBe(404);
  });

  test('GET /:threadId/stash/list returns stash entries', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    // Stash something first
    writeFileSync(resolve(TEST_REPO, 'stash-list-route.txt'), 'data');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });
    executeSync('git', ['stash', 'push', '-m', 'route test stash'], { cwd: TEST_REPO });

    const res = await app.request('/t1/stash/list');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toBeDefined();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);

    // Clean up
    executeSync('git', ['stash', 'drop'], { cwd: TEST_REPO, reject: false });
  });

  test('POST /:threadId/stash/pop returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/stash/pop', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/stash/pop pops the stash', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    // Create and stash a change
    writeFileSync(resolve(TEST_REPO, 'pop-route.txt'), 'pop me');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });
    executeSync('git', ['stash', 'push', '-m', 'pop test'], { cwd: TEST_REPO });

    const res = await app.request('/t1/stash/pop', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Clean up
    executeSync('git', ['checkout', '--', '.'], { cwd: TEST_REPO, reject: false });
    rmSync(resolve(TEST_REPO, 'pop-route.txt'), { force: true });
  });

  // ── Reset-soft route ──────────────────────────────────────

  test('POST /:threadId/reset-soft returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/reset-soft', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/reset-soft undoes last commit', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    // Create a commit to undo
    writeFileSync(resolve(TEST_REPO, 'reset-route.txt'), 'undo me');
    executeSync('git', ['add', '.'], { cwd: TEST_REPO });
    executeSync('git', ['commit', '-m', 'will undo via route'], { cwd: TEST_REPO });

    const res = await app.request('/t1/reset-soft', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify commit is gone
    const log = executeSync('git', ['log', '-1', '--format=%s'], { cwd: TEST_REPO });
    expect(log.stdout.trim()).not.toBe('will undo via route');

    // Clean up staged changes
    executeSync('git', ['restore', '--staged', '.'], { cwd: TEST_REPO, reject: false });
    rmSync(resolve(TEST_REPO, 'reset-route.txt'), { force: true });
  });

  // ── Gitignore route ───────────────────────────────────────

  test('POST /:threadId/gitignore returns 404 for non-existent thread', async () => {
    const res = await app.request('/nonexistent/gitignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: '*.log' }),
    });
    expect(res.status).toBe(404);
  });

  test('POST /:threadId/gitignore adds pattern', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1/gitignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: '*.log' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Clean up .gitignore
    executeSync('git', ['checkout', '--', '.gitignore'], { cwd: TEST_REPO, reject: false });
    rmSync(resolve(TEST_REPO, '.gitignore'), { force: true });
  });

  test('POST /:threadId/gitignore returns 400 when pattern missing', async () => {
    seedProject(testDb.db, { id: 'p1', path: TEST_REPO });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });

    const res = await app.request('/t1/gitignore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
