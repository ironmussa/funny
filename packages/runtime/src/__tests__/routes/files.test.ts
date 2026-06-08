/**
 * Regression tests for files.ts symlink-escape protection (audit C2).
 *
 * The route resolves every user-supplied path through `realpath()` once, then
 * performs all I/O on the canonical path. A symlink swap between check and
 * use cannot escape the project scope.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Hono } from 'hono';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import filesRoutes from '../../routes/files.js';
import type { RuntimeServiceProvider } from '../../services/service-provider.js';
import { setServices, resetServices } from '../../services/service-registry.js';

describe('files routes — symlink escape protection', () => {
  let projectDir: string;
  let outsideDir: string;
  let secretFile: string;
  let app: Hono;

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'funny-files-test-'));
    projectDir = join(tmp, 'project');
    outsideDir = join(tmp, 'outside');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    secretFile = join(outsideDir, 'secret.txt');
    writeFileSync(secretFile, 'TOP SECRET', 'utf-8');

    // A symlink inside the project that points OUTSIDE the project.
    symlinkSync(secretFile, join(projectDir, 'escape.txt'));

    const fakeServices = {
      projects: {
        listProjects: async (_userId: string) => [{ id: 'p1', name: 'p', path: projectDir }],
      },
    } as unknown as RuntimeServiceProvider;

    resetServices();
    setServices(fakeServices);

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'user-1' as never);
      await next();
    });
    app.route('/', filesRoutes);
  });

  afterAll(() => {
    resetServices();
    try {
      rmSync(join(projectDir, '..'), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('GET /read denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request(`/read?path=${encodeURIComponent(escape)}`);
    expect(res.status).toBe(403);
  });

  test('POST /write denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: escape, content: 'pwned' }),
    });
    expect(res.status).toBe(403);
  });

  test('GET /raw denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request(`/raw?path=${encodeURIComponent(escape)}`);
    expect(res.status).toBe(403);
  });

  test('GET /read allows a real file inside the project', async () => {
    const inside = join(projectDir, 'inside.txt');
    writeFileSync(inside, 'hello', 'utf-8');
    const res = await app.request(`/read?path=${encodeURIComponent(inside)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe('hello');
  });
});

describe('files routes — git blame', () => {
  let repoDir: string;
  let outsideDir: string;
  let app: Hono;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Blame Tester',
        GIT_AUTHOR_EMAIL: 'blame@test.dev',
        GIT_COMMITTER_NAME: 'Blame Tester',
        GIT_COMMITTER_EMAIL: 'blame@test.dev',
      },
      stdio: 'pipe',
    });

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'funny-blame-test-'));
    repoDir = join(tmp, 'repo');
    outsideDir = join(tmp, 'outside');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    git(repoDir, 'init', '-b', 'main');
    writeFileSync(
      join(repoDir, 'tracked.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      'utf-8',
    );
    git(repoDir, 'add', 'tracked.ts');
    git(repoDir, 'commit', '-m', 'add tracked.ts');

    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET', 'utf-8');
    symlinkSync(join(outsideDir, 'secret.txt'), join(repoDir, 'escape.txt'));

    const fakeServices = {
      projects: {
        listProjects: async (_userId: string) => [{ id: 'p1', name: 'repo', path: repoDir }],
      },
    } as unknown as RuntimeServiceProvider;

    resetServices();
    setServices(fakeServices);

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'user-1' as never);
      await next();
    });
    app.route('/', filesRoutes);
  });

  afterAll(() => {
    resetServices();
    try {
      rmSync(join(repoDir, '..'), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('GET /blame attributes every committed line to the commit that added it', async () => {
    const tracked = join(repoDir, 'tracked.ts');
    const res = await app.request(`/blame?path=${encodeURIComponent(tracked)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hunks: Array<{ startLine: number; lineCount: number; author: string; commitHash: string }>;
      blamedLineCount: number;
    };
    expect(body.blamedLineCount).toBe(3);
    expect(body.hunks.length).toBeGreaterThanOrEqual(1);
    // The whole file came from one commit, so the hunks cover lines 1..3.
    const coveredLines = body.hunks.reduce((n, h) => n + h.lineCount, 0);
    expect(coveredLines).toBe(3);
    expect(body.hunks[0].author).toBe('Blame Tester');
    expect(body.hunks[0].commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  test('GET /blame denies a symlink that escapes the project scope', async () => {
    const escape = join(repoDir, 'escape.txt');
    const res = await app.request(`/blame?path=${encodeURIComponent(escape)}`);
    expect(res.status).toBe(403);
  });
});
