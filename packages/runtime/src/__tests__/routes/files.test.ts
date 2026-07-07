/**
 * Regression tests for files.ts symlink-escape protection (audit C2).
 *
 * The route resolves every user-supplied path through `realpath()` once, then
 * performs all I/O on the canonical path. A symlink swap between check and
 * use cannot escape the project scope.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { signMediaClaim } from '@funny/shared/auth/media-url-signature';
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

describe('files routes — per-user temp assets scope', () => {
  // The agent writes dev assets to `<os-tmpdir>/funny-<userId>/`; those paths
  // are authorized for media serving even though they live outside any project.
  const USER = 'user-1';
  let assetsRoot: string;
  let assetFile: string;
  let app: Hono;

  beforeAll(() => {
    // Must match the canonical scope: <realpath(tmpdir)>/funny-<userId>.
    assetsRoot = join(realpathSync(tmpdir()), `funny-${USER}`);
    mkdirSync(assetsRoot, { recursive: true });
    assetFile = join(assetsRoot, 'render.png');
    writeFileSync(assetFile, 'PNGBYTES', 'utf-8');

    const fakeServices = {
      projects: {
        // No projects — proves the assets scope is independent of any project.
        listProjects: async (_userId: string) => [],
      },
    } as unknown as RuntimeServiceProvider;
    resetServices();
    setServices(fakeServices);

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, USER as never);
      await next();
    });
    app.route('/', filesRoutes);
  });

  afterAll(() => {
    resetServices();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('GET /raw allows a file inside the per-user assets root', async () => {
    // Bun.file is undefined under vitest's Node env, so the stream stage 500s —
    // assert the security wiring instead: an in-scope assets path is NOT denied
    // (403) at the scope check. Under Bun at runtime this is a 200 stream.
    const res = await app.request(`/raw?path=${encodeURIComponent(assetFile)}`);
    expect(res.status).not.toBe(403);
  });

  test("GET /raw denies another user's assets root", async () => {
    const otherFile = join(realpathSync(tmpdir()), 'funny-user-2', 'render.png');
    const res = await app.request(`/raw?path=${encodeURIComponent(otherFile)}`);
    expect(res.status).toBe(403);
  });

  test('GET /raw denies a sibling-prefix escape of the assets root', async () => {
    // `funny-user-1evil` must not match `funny-user-1` (the `+ sep` guard).
    const sibling = join(realpathSync(tmpdir()), `funny-${USER}evil`, 'x.png');
    const res = await app.request(`/raw?path=${encodeURIComponent(sibling)}`);
    expect(res.status).toBe(403);
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
  const gitAs = (cwd: string, author: { name: string; email: string }, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
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

    writeFileSync(join(repoDir, 'origin.ts'), 'export const moved = true;\n', 'utf-8');
    gitAs(repoDir, { name: 'Jhonner Creator', email: 'jhonner@test.dev' }, 'add', 'origin.ts');
    gitAs(
      repoDir,
      { name: 'Jhonner Creator', email: 'jhonner@test.dev' },
      'commit',
      '-m',
      'create origin.ts',
    );
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    gitAs(
      repoDir,
      { name: 'Jesus Mover', email: 'jesus@test.dev' },
      'mv',
      'origin.ts',
      'src/moved.ts',
    );
    gitAs(
      repoDir,
      { name: 'Jesus Mover', email: 'jesus@test.dev' },
      'commit',
      '-m',
      'move origin.ts',
    );

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

  test('GET /history follows file moves back to the creation commit', async () => {
    const moved = join(repoDir, 'src', 'moved.ts');
    const res = await app.request(`/history?path=${encodeURIComponent(moved)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      author: string;
      message: string;
      status: string;
      path: string;
      previousPath: string | null;
    }>;
    expect(body.map((entry) => entry.author)).toEqual(['Jesus Mover', 'Jhonner Creator']);
    expect(body[0]).toMatchObject({
      message: 'move origin.ts',
      status: 'renamed',
      path: 'src/moved.ts',
      previousPath: 'origin.ts',
    });
    expect(body[1]).toMatchObject({
      message: 'create origin.ts',
      status: 'added',
      path: 'origin.ts',
      previousPath: null,
    });
  });
});

describe('files routes — /raw-signed (transport C)', () => {
  const SECRET = 'runtime-test-secret';
  const USER = 'user-1';
  let projectDir: string;
  let outsideDir: string;
  let insideFile: string;
  let outsideFile: string;
  let app: Hono;

  function signedUrl(opts: {
    urlPath: string;
    signPath?: string;
    expires?: number;
    secret?: string;
  }): string {
    const expires = opts.expires ?? Date.now() + 60_000;
    const sig = signMediaClaim(
      { path: opts.signPath ?? opts.urlPath, userId: USER, expires },
      opts.secret ?? SECRET,
    );
    const p = new URLSearchParams({ path: opts.urlPath, u: USER, exp: String(expires), sig });
    return `/raw-signed?${p.toString()}`;
  }

  beforeAll(() => {
    process.env.RUNNER_AUTH_SECRET = SECRET;
    const tmp = mkdtempSync(join(tmpdir(), 'funny-rawsigned-test-'));
    projectDir = join(tmp, 'project');
    outsideDir = join(tmp, 'outside');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    insideFile = join(projectDir, 'pic.png');
    outsideFile = join(outsideDir, 'secret.png');
    writeFileSync(insideFile, 'PNGBYTES', 'utf-8');
    writeFileSync(outsideFile, 'SECRET', 'utf-8');

    const fakeServices = {
      projects: {
        listProjects: async (_userId: string) => [{ id: 'p1', name: 'p', path: projectDir }],
      },
    } as unknown as RuntimeServiceProvider;
    resetServices();
    setServices(fakeServices);

    // NO auth middleware here — /raw-signed authenticates via the signature alone.
    app = new Hono();
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

  test('a valid in-scope signature passes auth + scope (reaches the stream stage)', async () => {
    // NOTE: the actual byte streaming uses `Bun.file`, which is undefined under
    // vitest's Node env (the same reason /raw's happy path isn't asserted here) —
    // so this 500s on the stream itself. What we assert is the security wiring:
    // a valid signature for an in-scope path is NOT rejected at auth (401) or
    // scope (403); it gets all the way to streaming. Under Bun at runtime it's 200.
    const res = await app.request(signedUrl({ urlPath: insideFile }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test('401 for an expired signature', async () => {
    const res = await app.request(signedUrl({ urlPath: insideFile, expires: Date.now() - 1 }));
    expect(res.status).toBe(401);
  });

  test('401 when the path is tampered (signature no longer matches)', async () => {
    // Sign the in-scope file but request a different path under the same params.
    const res = await app.request(signedUrl({ urlPath: outsideFile, signPath: insideFile }));
    expect(res.status).toBe(401);
  });

  test('401 for a signature minted with the wrong secret', async () => {
    const res = await app.request(signedUrl({ urlPath: insideFile, secret: 'wrong-secret' }));
    expect(res.status).toBe(401);
  });

  test('403 for a validly-signed path that is OUTSIDE the user project scope', async () => {
    // The signature is authentication, not authorization: a valid token for an
    // out-of-scope path is still denied by the per-user scope check.
    const res = await app.request(signedUrl({ urlPath: outsideFile }));
    expect(res.status).toBe(403);
  });
});
