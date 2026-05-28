import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { okAsync } from 'neverthrow';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { testPath } from '../helpers/test-dirname.js';

const REPO = testPath(import.meta, '..', '..', '..', '.test-tmp-git-service');

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  getGitIdentity: vi.fn(),
  getGithubToken: vi.fn(),
  stageFiles: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    profile: {
      getGitIdentity: mocks.getGitIdentity,
      getGithubToken: mocks.getGithubToken,
    },
  }),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  return {
    ...actual,
    stageFiles: mocks.stageFiles,
    invalidateStatusCache: vi.fn(),
  };
});

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: { emit: mocks.emit },
}));

import { resolveIdentity, validateFilePaths, stage } from '../../services/git-service.js';

function setupRepo() {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  writeFileSync(resolve(REPO, 'file.txt'), 'hello');
}

describe('git-service', () => {
  beforeAll(() => {
    setupRepo();
  });

  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThread.mockResolvedValue({ id: 't1', projectId: 'p1' });
    mocks.stageFiles.mockReturnValue(okAsync(undefined));
  });

  describe('validateFilePaths', () => {
    test('accepts paths inside the working directory', () => {
      const result = validateFilePaths(REPO, ['file.txt']);
      expect(result.isOk()).toBe(true);
    });

    test('rejects path traversal', () => {
      const result = validateFilePaths(REPO, ['../../../etc/passwd']);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toMatch(/Invalid path/);
      }
    });
  });

  describe('resolveIdentity', () => {
    test('returns undefined when profile has no git identity or token', async () => {
      mocks.getGitIdentity.mockResolvedValue(null);
      mocks.getGithubToken.mockResolvedValue(null);

      const identity = await resolveIdentity('user-1');

      expect(identity).toBeUndefined();
    });

    test('combines author and github token from profile', async () => {
      mocks.getGitIdentity.mockResolvedValue({ name: 'Test', email: 't@test.com' });
      mocks.getGithubToken.mockResolvedValue('ghp_test');

      const identity = await resolveIdentity('user-1');

      expect(identity).toEqual({
        author: { name: 'Test', email: 't@test.com' },
        githubToken: 'ghp_test',
      });
    });
  });

  describe('stage', () => {
    test('stages files and emits git:staged with project context', async () => {
      const result = await stage('t1', 'user-1', REPO, ['file.txt'], 'wf-1');

      expect(result.isOk()).toBe(true);
      expect(mocks.stageFiles).toHaveBeenCalledWith(REPO, ['file.txt']);
      expect(mocks.emit).toHaveBeenCalledWith(
        'git:staged',
        expect.objectContaining({
          threadId: 't1',
          userId: 'user-1',
          projectId: 'p1',
          paths: ['file.txt'],
          cwd: REPO,
          workflowId: 'wf-1',
        }),
      );
    });
  });
});
