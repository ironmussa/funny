import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Hono } from 'hono';
import { ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression (#179): POST /clone validated `destinationPath` against the
 * picker scope, then cloned into `join(destinationPath, name)` with an
 * unconstrained `name`, so `../.ssh/x` escaped the validated directory. The
 * directory name — given or derived from the URL — must be one path segment.
 */

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  projectNameExists: vi.fn(async () => false),
  requirePickerPath: vi.fn(async (_path: string): Promise<Response | null> => null),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      createProject: mocks.createProject,
      projectNameExists: mocks.projectNameExists,
    },
  }),
}));

vi.mock('../../routes/github/helpers.js', () => ({
  githubApiFetch: vi.fn(),
  resolveGithubToken: vi.fn(async () => null),
}));

vi.mock('../../utils/path-scope.js', () => ({
  requirePickerPath: mocks.requirePickerPath,
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emitToUser: vi.fn() },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { repoRoutes } from '../../routes/github/repos.js';
import type { HonoEnv } from '../../types/hono-env.js';

function postClone(body: Record<string, unknown>) {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  a.route('/gh', repoRoutes);
  return a.request('/gh/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /clone directory name', () => {
  let parentDir: string;
  let spawn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'funny-clone-name-'));
    mocks.createProject.mockReset();
    mocks.createProject.mockResolvedValue(ok({ id: 'p-1', name: 'widget', path: '' }));
    mocks.requirePickerPath.mockReset();
    mocks.requirePickerPath.mockResolvedValue(null);
    spawn = vi.spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
        }) as unknown as ReturnType<typeof Bun.spawn>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(parentDir, { recursive: true, force: true });
  });

  test.each(['../.ssh/x', '..', '.', 'a/b', 'a\\b', '..\\evil', 'bad\0name'])(
    'rejects name %j without cloning',
    async (name) => {
      const res = await postClone({
        cloneUrl: 'https://github.com/acme/widget.git',
        destinationPath: parentDir,
        name,
      });

      expect(res.status).toBe(400);
      expect(spawn).not.toHaveBeenCalled();
      expect(mocks.createProject).not.toHaveBeenCalled();
    },
  );

  test('rejects a URL whose last segment is not a valid directory name', async () => {
    const res = await postClone({
      cloneUrl: 'https://github.com/acme/..',
      destinationPath: parentDir,
    });

    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  test('checks the clone path itself against the picker scope', async () => {
    // `.kube` is a single segment, but under $HOME it is a blocked credential dir.
    const blocked = join(parentDir, '.kube');
    mocks.requirePickerPath.mockImplementation(async (path: string) =>
      path === blocked ? new Response('Access denied', { status: 403 }) : null,
    );

    const res = await postClone({
      cloneUrl: 'https://github.com/acme/widget.git',
      destinationPath: parentDir,
      name: '.kube',
    });

    expect(res.status).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('falls back to the URL name when name is empty', async () => {
    await postClone({
      cloneUrl: 'https://github.com/acme/widget.git',
      destinationPath: parentDir,
      name: '',
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn.mock.calls[0][0] as string[]).at(-1)).toBe(join(parentDir, 'widget'));
  });

  test('clones a plain name into the destination directory', async () => {
    await postClone({
      cloneUrl: 'https://github.com/acme/widget.git',
      destinationPath: parentDir,
      name: 'my-widget',
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0][0] as string[];
    expect(args.at(-1)).toBe(join(parentDir, 'my-widget'));
  });
});
