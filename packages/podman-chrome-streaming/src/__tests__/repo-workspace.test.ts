import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { err, ok } from 'neverthrow';

import type { RuntimeConfig } from '../runtime/types.ts';

const TMP_DIR = join(import.meta.dir, '..', '..', '.test-tmp-repo-workspace');

const cloneRepoMock = mock(async (_repoUrl: string, _destination: string) => ok('cloned'));
const getCurrentBranchMock = mock(async (_cwd: string) => ok('main'));
const getDefaultBranchMock = mock(async (_cwd: string) => ok('main'));
const gitMock = mock(async (_args: string[], _cwd: string) => ok('ok'));
const isGitRepoMock = mock(async (_cwd: string) => true);

mock.module('@funny/core/git', () => ({
  cloneRepo: cloneRepoMock,
  getCurrentBranch: getCurrentBranchMock,
  getDefaultBranch: getDefaultBranchMock,
  git: gitMock,
  isGitRepo: isGitRepoMock,
}));

import {
  checkoutRef,
  createWorkBranch,
  prepareCloneWorkspace,
  prepareMountedWorkspace,
  prepareWorkspace,
  validateGitRepo,
  workspaceHasContent,
} from '../runtime/repo-workspace.ts';

function createBaseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    repoMode: 'clone',
    repoUrl: 'https://github.com/org/repo.git',
    repoRef: undefined,
    workBranch: undefined,
    gitToken: undefined,
    gitTokenFile: undefined,
    gitUsername: 'x-access-token',
    workspacePath: join(TMP_DIR, 'workspace'),
    funnyPort: 3001,
    clientOrigin: undefined,
    authMode: 'local',
    funnyDataDir: join(TMP_DIR, 'data'),
    enableRuntime: true,
    enableStreaming: true,
    streamViewerPort: 3500,
    streamWsPort: 3501,
    novncPort: 6080,
    chromeDebugPort: 9222,
    startUrl: 'https://example.com',
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  cloneRepoMock.mockImplementation(async () => ok('cloned'));
  getCurrentBranchMock.mockImplementation(async () => ok('main'));
  getDefaultBranchMock.mockImplementation(async () => ok('main'));
  gitMock.mockImplementation(async () => ok('ok'));
  isGitRepoMock.mockImplementation(async () => true);

  cloneRepoMock.mockClear();
  getCurrentBranchMock.mockClear();
  getDefaultBranchMock.mockClear();
  gitMock.mockClear();
  isGitRepoMock.mockClear();
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('prepareWorkspace', () => {
  it('dispatches clone mode to prepareCloneWorkspace', async () => {
    const workspace = await prepareWorkspace(createBaseConfig());

    expect(workspace.mode).toBe('clone');
  });

  it('dispatches mount mode to prepareMountedWorkspace', async () => {
    const workspacePath = join(TMP_DIR, 'mounted');
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const workspace = await prepareWorkspace(
      createBaseConfig({
        repoMode: 'mount',
        workspacePath,
      }),
    );

    expect(workspace.mode).toBe('mount');
    expect(workspace.cloned).toBe(false);
  });
});

describe('prepareCloneWorkspace', () => {
  it('throws when repoUrl is missing', async () => {
    await expect(
      prepareCloneWorkspace(
        createBaseConfig({
          repoUrl: undefined,
        }),
      ),
    ).rejects.toThrow('REPO_URL is required when REPO_MODE=clone');
  });

  it('clones the repository and uses authenticated URL when token is provided', async () => {
    const tokenFile = join(TMP_DIR, 'token.txt');
    writeFileSync(tokenFile, 'test-tok\n');

    const workspace = await prepareCloneWorkspace(
      createBaseConfig({
        gitTokenFile: tokenFile,
        repoRef: 'main',
        workBranch: 'feature/test',
      }),
    );

    expect(cloneRepoMock).toHaveBeenCalledWith(
      `https://x-access-token:${'test-tok'}@github.com/org/repo.git`,
      join(TMP_DIR, 'workspace'),
    );
    expect(workspace).toMatchObject({
      mode: 'clone',
      cloned: true,
      activeRef: 'main',
      workBranch: 'feature/test',
    });
  });

  it('reuses an existing clone instead of cloning again', async () => {
    const workspacePath = join(TMP_DIR, 'existing-workspace');
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const workspace = await prepareCloneWorkspace(
      createBaseConfig({
        workspacePath,
      }),
    );

    expect(cloneRepoMock).not.toHaveBeenCalled();
    expect(workspace.cloned).toBe(false);
  });

  it('redacts credentials in clone errors', async () => {
    cloneRepoMock.mockImplementation(async () =>
      err({ message: `fatal: https://user:${'tok'}@github.com/org/repo.git failed` } as any),
    );

    await expect(prepareCloneWorkspace(createBaseConfig())).rejects.toThrow(
      `https://***:***@github.com/org/repo.git failed`,
    );
  });
});

describe('prepareMountedWorkspace', () => {
  it('throws when mounted workspace path does not exist', async () => {
    await expect(
      prepareMountedWorkspace(
        createBaseConfig({
          repoMode: 'mount',
          workspacePath: join(TMP_DIR, 'missing'),
        }),
      ),
    ).rejects.toThrow('Mounted workspace not found');
  });

  it('throws when mounted workspace is not a git repository', async () => {
    const workspacePath = join(TMP_DIR, 'not-a-repo');
    mkdirSync(workspacePath, { recursive: true });

    await expect(
      prepareMountedWorkspace(
        createBaseConfig({
          repoMode: 'mount',
          workspacePath,
        }),
      ),
    ).rejects.toThrow('Mounted workspace is not a git repository');
  });

  it('returns mounted workspace metadata for a valid repository', async () => {
    const workspacePath = join(TMP_DIR, 'repo');
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const workspace = await prepareMountedWorkspace(
      createBaseConfig({
        repoMode: 'mount',
        workspacePath,
        repoRef: 'develop',
      }),
    );

    expect(workspace).toMatchObject({
      workspacePath,
      mode: 'mount',
      cloned: false,
      activeRef: 'develop',
    });
  });
});

describe('validateGitRepo', () => {
  it('returns false when path or .git directory is missing', async () => {
    expect(await validateGitRepo(join(TMP_DIR, 'missing'))).toBe(false);

    const folderOnly = join(TMP_DIR, 'folder-only');
    mkdirSync(folderOnly, { recursive: true });
    expect(await validateGitRepo(folderOnly)).toBe(false);
  });

  it('returns the result of isGitRepo when .git exists', async () => {
    const repoPath = join(TMP_DIR, 'repo-ok');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    isGitRepoMock.mockImplementation(async () => true);
    expect(await validateGitRepo(repoPath)).toBe(true);

    isGitRepoMock.mockImplementation(async () => false);
    expect(await validateGitRepo(repoPath)).toBe(false);
  });
});

describe('checkoutRef', () => {
  it('returns the active branch when no repoRef is provided', async () => {
    getCurrentBranchMock.mockImplementation(async () => ok('feature/current'));

    await expect(checkoutRef(TMP_DIR)).resolves.toBe('feature/current');
  });

  it('falls back to default branch when current branch lookup fails', async () => {
    getCurrentBranchMock.mockImplementation(async () => err({ message: 'no branch' } as any));
    getDefaultBranchMock.mockImplementation(async () => ok('master'));

    await expect(checkoutRef(TMP_DIR)).resolves.toBe('master');
  });

  it('checks out the ref directly when possible', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout' && args[1] === 'develop') {
        return ok('ok');
      }
      return err({ message: 'unexpected' } as any);
    });

    await expect(checkoutRef(TMP_DIR, 'develop')).resolves.toBe('develop');
  });

  it('falls back to origin/ref when direct checkout fails', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'checkout release') {
        return err({ message: 'missing local ref' } as any);
      }
      if (args.join(' ') === 'checkout -B release origin/release') {
        return ok('ok');
      }
      return err({ message: 'unexpected' } as any);
    });

    await expect(checkoutRef(TMP_DIR, 'release')).resolves.toBe('release');
  });

  it('throws when both checkout strategies fail', async () => {
    gitMock.mockImplementation(async () => err({ message: 'bad ref' } as any));

    await expect(checkoutRef(TMP_DIR, 'missing-branch')).rejects.toThrow(
      'Failed to checkout ref "missing-branch"',
    );
  });
});

describe('createWorkBranch', () => {
  it('returns undefined when no work branch is requested', async () => {
    await expect(createWorkBranch(TMP_DIR)).resolves.toBeUndefined();
  });

  it('returns the work branch when already on it', async () => {
    getCurrentBranchMock.mockImplementation(async () => ok('feature/current'));

    await expect(createWorkBranch(TMP_DIR, 'feature/current')).resolves.toBe('feature/current');
  });

  it('checks out an existing branch when available', async () => {
    getCurrentBranchMock.mockImplementation(async () => ok('main'));
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'checkout feature/existing') {
        return ok('ok');
      }
      return err({ message: 'unexpected' } as any);
    });

    await expect(createWorkBranch(TMP_DIR, 'feature/existing')).resolves.toBe('feature/existing');
  });

  it('creates a new branch when checkout of existing branch fails', async () => {
    getCurrentBranchMock.mockImplementation(async () => ok('main'));
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'checkout feature/new') {
        return err({ message: 'missing branch' } as any);
      }
      if (args.join(' ') === 'checkout -b feature/new') {
        return ok('ok');
      }
      return err({ message: 'unexpected' } as any);
    });

    await expect(createWorkBranch(TMP_DIR, 'feature/new')).resolves.toBe('feature/new');
  });

  it('throws when creating the work branch fails', async () => {
    getCurrentBranchMock.mockImplementation(async () => ok('main'));
    gitMock.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'checkout feature/bad') {
        return err({ message: 'missing branch' } as any);
      }
      if (args.join(' ') === 'checkout -b feature/bad') {
        return err({ message: 'permission denied' } as any);
      }
      return err({ message: 'unexpected' } as any);
    });

    await expect(createWorkBranch(TMP_DIR, 'feature/bad')).rejects.toThrow(
      'Failed to create work branch "feature/bad": permission denied',
    );
  });
});

describe('workspaceHasContent', () => {
  it('returns false for missing or empty directories and true otherwise', () => {
    expect(workspaceHasContent(join(TMP_DIR, 'missing'))).toBe(false);

    const emptyDir = join(TMP_DIR, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    expect(workspaceHasContent(emptyDir)).toBe(false);

    writeFileSync(join(emptyDir, 'file.txt'), 'hello');
    expect(workspaceHasContent(emptyDir)).toBe(true);
  });
});
