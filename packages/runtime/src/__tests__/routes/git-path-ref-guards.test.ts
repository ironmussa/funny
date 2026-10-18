/**
 * Security regression tests for the git read routes reachable by steer
 * sharees:
 *  - H5: `/diff/file?path=` must not read files outside the thread/project cwd.
 *  - M7: `/commit/:hash/*` must reject hashes that git would parse as options.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { errAsync, okAsync } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
  resolveProjectPath: vi.fn(),
  getSingleFileDiff: vi.fn(),
  getFullContextFileDiff: vi.fn(),
  getCommitBody: vi.fn(),
  getCommitFiles: vi.fn(),
  getCommitFileDiff: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
  listThreads: vi.fn(async () => ({ threads: [] })),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mocks.getProject,
      isProjectInOrg: mocks.isProjectInOrg,
      resolveProjectPath: mocks.resolveProjectPath,
    },
  }),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  return {
    ...actual,
    getSingleFileDiff: mocks.getSingleFileDiff,
    getFullContextFileDiff: mocks.getFullContextFileDiff,
    getCommitBody: mocks.getCommitBody,
    getCommitFiles: mocks.getCommitFiles,
    getCommitFileDiff: mocks.getCommitFileDiff,
  };
});

vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { gitRoutes } from '../../routes/git.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'git-path-guard-')));
const CWD = join(ROOT, 'repo');
mkdirSync(join(CWD, 'src'), { recursive: true });
writeFileSync(join(CWD, 'src', 'a.ts'), 'export {};\n');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A steer sharee (non-owner) on thread t1 — the route set H5 is reachable from. */
function makeSteerApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'sharee-1');
    c.set('organizationId', null);
    c.set('shareLevel', 'steer');
    c.set('onBehalfOfThread', 't1');
    return next();
  });
  app.route('/api/git', gitRoutes);
  return app;
}

function makeOwnerApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'owner-1');
    c.set('organizationId', null);
    return next();
  });
  app.route('/api/git', gitRoutes);
  return app;
}

const q = (p: string) => encodeURIComponent(p);

describe('git path / ref guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThread.mockResolvedValue({
      id: 't1',
      userId: 'owner-1',
      projectId: 'p1',
      worktreePath: CWD,
      isScratch: false,
    });
    mocks.getProject.mockResolvedValue({ id: 'p1', userId: 'owner-1', path: CWD });
    mocks.isProjectInOrg.mockResolvedValue(false);
    mocks.resolveProjectPath.mockReturnValue(errAsync(badRequest('no collaborator path')));
    mocks.getSingleFileDiff.mockReturnValue(okAsync('diff'));
    mocks.getFullContextFileDiff.mockReturnValue(okAsync('full diff'));
    mocks.getCommitBody.mockReturnValue(okAsync('body'));
    mocks.getCommitFiles.mockReturnValue(okAsync([]));
    mocks.getCommitFileDiff.mockReturnValue(okAsync('commit diff'));
  });

  describe('H5: /diff/file path containment', () => {
    for (const bad of ['/etc/passwd', '../../x', 'src/../../x', `${ROOT}/repo-secrets/key`]) {
      test(`thread route rejects ${bad}`, async () => {
        for (const context of ['', '&context=full']) {
          const res = await makeSteerApp().request(
            `/api/git/t1/diff/file?path=${q(bad)}&staged=false${context}`,
          );
          expect(res.status).toBe(400);
        }
        expect(mocks.getSingleFileDiff).not.toHaveBeenCalled();
        expect(mocks.getFullContextFileDiff).not.toHaveBeenCalled();
      });

      test(`project route rejects ${bad}`, async () => {
        const res = await makeOwnerApp().request(
          `/api/git/project/p1/diff/file?path=${q(bad)}&staged=false`,
        );
        expect(res.status).toBe(400);
        expect(mocks.getSingleFileDiff).not.toHaveBeenCalled();
      });
    }

    test('submodule routes reject a symlinked "submodule" that points outside the cwd', async () => {
      const outsideRepo = join(ROOT, 'outside-repo');
      mkdirSync(join(outsideRepo, '.git'), { recursive: true });
      writeFileSync(join(outsideRepo, 'secret.txt'), 'secret');
      symlinkSync(outsideRepo, join(CWD, 'evil-sub'));
      const res = await makeSteerApp().request(
        `/api/git/t1/diff/submodule/file?submodule=evil-sub&path=secret.txt`,
      );
      expect(res.status).toBe(400);
      expect(mocks.getSingleFileDiff).not.toHaveBeenCalled();
    });

    test('thread route accepts a relative path inside the cwd', async () => {
      const res = await makeSteerApp().request(`/api/git/t1/diff/file?path=src/a.ts&staged=false`);
      expect(res.status).toBe(200);
      expect(mocks.getSingleFileDiff).toHaveBeenCalledWith(CWD, 'src/a.ts', false);
    });

    test('absolute path inside the cwd is converted to a relative path', async () => {
      const res = await makeSteerApp().request(
        `/api/git/t1/diff/file?path=${q(join(CWD, 'src', 'a.ts'))}&staged=false&context=full`,
      );
      expect(res.status).toBe(200);
      expect(mocks.getFullContextFileDiff).toHaveBeenCalledWith(CWD, join('src', 'a.ts'), false);
    });
  });

  describe('M7: commit hash validation', () => {
    const evil = q('--output=/tmp/x');
    const cases: Array<[string, () => Hono<HonoEnv>, string]> = [
      ['thread body', makeSteerApp, `/api/git/t1/commit/${evil}/body`],
      ['thread files', makeSteerApp, `/api/git/t1/commit/${evil}/files`],
      ['thread diff', makeSteerApp, `/api/git/t1/commit/${evil}/diff?path=a.ts`],
      ['project body', makeOwnerApp, `/api/git/project/p1/commit/${evil}/body`],
      ['project files', makeOwnerApp, `/api/git/project/p1/commit/${evil}/files`],
      ['project diff', makeOwnerApp, `/api/git/project/p1/commit/${evil}/diff?path=a.ts`],
    ];
    for (const [name, makeApp, url] of cases) {
      test(`${name} rejects an option-shaped hash`, async () => {
        const res = await makeApp().request(url);
        expect(res.status).toBe(400);
        expect(mocks.getCommitBody).not.toHaveBeenCalled();
        expect(mocks.getCommitFiles).not.toHaveBeenCalled();
        expect(mocks.getCommitFileDiff).not.toHaveBeenCalled();
      });
    }

    test('a real hash still works', async () => {
      const res = await makeSteerApp().request('/api/git/t1/commit/abc123def/body');
      expect(res.status).toBe(200);
      expect(mocks.getCommitBody).toHaveBeenCalledWith(CWD, 'abc123def');
    });
  });
});
