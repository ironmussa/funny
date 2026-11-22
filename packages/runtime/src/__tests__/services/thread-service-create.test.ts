import { describe, test, expect, vi, beforeEach, mock } from 'bun:test';

import { mocked, waitFor } from '@funny/test-kit';

const mocks = (() => ({
  releaseStagedUploads: vi.fn(),
  tm: {
    createThread: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string): Promise<{ id: string } | undefined> => ({ id })),
    insertMessage: vi.fn(async () => 'msg-1'),
    insertToolCall: vi.fn(async () => 'tc-shell'),
    updateToolCallOutput: vi.fn(async () => undefined),
    updateThread: vi.fn(async () => undefined),
  },
  projects: {
    getProject: vi.fn(),
    resolveProjectPath: vi.fn(),
  },
  profile: {
    getGithubToken: vi.fn(async () => 'gh-token'),
  },
  threadEventBus: {
    emit: vi.fn(),
  },
  startAgent: vi.fn(async (..._args: unknown[]) => undefined),
  getCurrentBranch: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  removeBranch: vi.fn(),
  setupWorktree: vi.fn(),
  git: vi.fn(),
  findWorktreeForBranch: vi.fn(),
  isRegisteredWorktreePath: vi.fn(),
  launchContainer: vi.fn(),
  safeFetchUserUrl: vi.fn(),
  listPermissionRules: vi.fn(async (): Promise<any[]> => []),
  adoptStagedUploads: vi.fn(),
  copyThreadUploads: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async (path: string) => ({ isDirectory: () => !/\.[a-z]+$/.test(path) })),
  executeShellEscape: vi.fn(async (command: string) => ({
    command,
    stdout: 'hello',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  })),
}))();

mock.module('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
}));

mock.module('nanoid', () => ({ nanoid: () => 'fixed-thread-id' }));

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

mock.module('../../services/thread-manager.js', () => mocks.tm);

mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: mocks.projects, profile: mocks.profile }),
}));

mock.module('../../services/thread-event-bus.js', () => ({
  threadEventBus: mocks.threadEventBus,
}));

mock.module('../../services/agent-runner-control.js', () => ({
  startAgent: mocks.startAgent,
}));

mock.module('../../services/permission-rules-client.js', () => ({
  listPermissionRules: mocks.listPermissionRules,
}));

mock.module('../../services/podman-service.js', () => ({
  launchContainer: mocks.launchContainer,
}));

mock.module('../../lib/ssrf-guard.js', () => ({
  safeFetchUserUrl: mocks.safeFetchUserUrl,
}));

mock.module('../../utils/file-mentions.js', () => ({
  augmentPromptWithFiles: vi.fn(async (content: string) => content),
  augmentPromptWithSymbols: vi.fn(async (content: string) => content),
  stripInlineReferencedContent: vi.fn((content: string) => content),
}));

mock.module('../../services/thread-service/staged-uploads.js', () => ({
  releaseStagedUploads: mocks.releaseStagedUploads,
  adoptStagedUploads: mocks.adoptStagedUploads,
  copyThreadUploads: mocks.copyThreadUploads,
}));

mock.module('fs/promises', () => ({ mkdir: mocks.mkdir, stat: mocks.stat }));

const actualShellEscape = { ...(await import('../../services/thread-service/shell-escape.js')) };
mock.module('../../services/thread-service/shell-escape.js', () => {
  const actual = actualShellEscape;
  return {
    ...actual,
    executeShellEscape: mocks.executeShellEscape,
  };
});

mock.module('@funny/core/git', () => ({
  getCurrentBranch: mocks.getCurrentBranch,
  createWorktree: mocks.createWorktree,
  removeWorktree: mocks.removeWorktree,
  removeBranch: mocks.removeBranch,
  configuredWorktreeRoot: () => null,
  git: mocks.git,
  findWorktreeForBranch: mocks.findWorktreeForBranch,
  isRegisteredWorktreePath: mocks.isRegisteredWorktreePath,
  isContainedPath: (base: string, full: string) => full.startsWith(`${base}/`),
}));

mock.module('@funny/core/ports', () => ({
  setupWorktree: mocks.setupWorktree,
}));

import { DEFAULT_MODEL } from '@funny/shared/models';
import { ok, err, okAsync, errAsync } from 'neverthrow';

// Released on success; the create/send flows await it.
mocks.releaseStagedUploads.mockImplementation(() => okAsync(undefined));

import { log } from '../../lib/logger.js';
import { createIdleThread, createAndStartThread } from '../../services/thread-service/create.js';
import { wsBroker } from '../../services/ws-broker.js';

const baseProject = {
  id: 'p-1',
  name: 'My App',
  path: '/projects/my-app',
  defaultProvider: 'claude',
  defaultModel: 'sonnet',
  defaultPermissionMode: 'autoEdit',
};

describe('createIdleThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue(baseProject);
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/projects/my-app'));
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.findWorktreeForBranch.mockResolvedValue(ok(null));
    mocks.isRegisteredWorktreePath.mockResolvedValue(ok(true));
  });

  test('returns 404 when project is missing', async () => {
    mocks.projects.getProject.mockResolvedValue(null);

    const result = await createIdleThread({
      projectId: 'missing',
      userId: 'u-1',
      title: 'Draft',
      mode: 'local',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
      expect(result.error.message).toBe('Project not found');
    }
    expect(mocks.tm.createThread).not.toHaveBeenCalled();
  });

  test('returns 400 when project path cannot be resolved', async () => {
    mocks.projects.resolveProjectPath.mockResolvedValue(err(new Error('no local path')));

    const result = await createIdleThread({
      projectId: 'p-1',
      userId: 'u-1',
      title: 'Draft',
      mode: 'local',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
    }
  });

  test('creates a local idle thread and emits thread:created', async () => {
    const result = await createIdleThread({
      projectId: 'p-1',
      userId: 'u-1',
      title: 'Backlog item',
      mode: 'local',
      stage: 'planning',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixed-thread-id',
        projectId: 'p-1',
        userId: 'u-1',
        title: 'Backlog item',
        mode: 'local',
        status: 'idle',
        stage: 'planning',
        branch: 'main',
        baseBranch: 'main',
      }),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        projectId: 'p-1',
        userId: 'u-1',
        status: 'idle',
      }),
    );
  });

  test('persists initial prompt as a user message when provided', async () => {
    const result = await createIdleThread({
      projectId: 'p-1',
      userId: 'u-1',
      title: 'With prompt',
      mode: 'local',
      prompt: 'Implement feature X',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        role: 'user',
        content: 'Implement feature X',
      }),
    );
  });

  test('keeps @-mentions and staged uploads as a path-only manifest in the prompt', async () => {
    mocks.adoptStagedUploads.mockReturnValue(
      okAsync([{ path: '.funny/uploads/fixed-thread-id/spec.pdf' }]),
    );

    const result = await createIdleThread({
      projectId: 'p-1',
      userId: 'u-1',
      title: 'Backlog',
      mode: 'local',
      prompt: 'Review these',
      fileReferences: [{ path: 'src/a.ts' }, { path: 'docs' }, { path: '../outside.ts' }],
      stagedUploads: ['0b6f4a8e-3c2d-4e5f-9a1b-2c3d4e5f6a7b'],
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.adoptStagedUploads).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/projects/my-app', threadId: 'fixed-thread-id' }),
    );
    const manifest =
      '<referenced-files>\n' +
      '<file path="src/a.ts" />\n' +
      '<folder path="docs"></folder>\n' +
      '<file path="../outside.ts" />\n' +
      '<file path=".funny/uploads/fixed-thread-id/spec.pdf" />\n' +
      '</referenced-files>\n\nReview these';
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: manifest }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: manifest }),
    );
    // Only the containment-checked paths are stat'ed for the chip type.
    expect(mocks.stat).not.toHaveBeenCalledWith('/projects/outside.ts');
    expect(mocks.stat).toHaveBeenCalledWith('/projects/my-app/docs');
  });

  test('uses worktree branch naming in worktree mode', async () => {
    const result = await createIdleThread({
      projectId: 'p-1',
      userId: 'u-1',
      title: 'Feature Branch',
      mode: 'worktree',
      baseBranch: 'develop',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'worktree',
        branch: 'my-app/feature-branch-fixed-',
        baseBranch: 'develop',
      }),
    );
    expect(mocks.getCurrentBranch).not.toHaveBeenCalled();
  });
});

describe('createAndStartThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue(baseProject);
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/projects/my-app'));
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
  });

  test('requires projectId for non-scratch threads', async () => {
    const result = await createAndStartThread({
      projectId: null,
      userId: 'u-1',
      mode: 'local',
      prompt: 'Go',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('projectId is required');
    }
  });

  test('creates a pending local thread and starts the agent', async () => {
    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      prompt: 'Fix the bug',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixed-thread-id',
        projectId: 'p-1',
        status: 'pending',
        mode: 'local',
        branch: 'main',
      }),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        cwd: '/projects/my-app',
        status: 'pending',
      }),
    );
    expect(mocks.startAgent).toHaveBeenCalledWith(
      'fixed-thread-id',
      'Fix the bug',
      '/projects/my-app',
      'sonnet',
      'autoEdit',
      undefined,
      undefined,
      undefined,
      'claude',
      undefined,
      undefined,
      undefined,
    );
  });

  test.each([
    {
      name: 'no model: the project provider and model',
      want: ['gpt-5.6-sol', 'codex'],
    },
    {
      name: 'a model without provider: a Claude model',
      model: 'opus-5.5',
      want: ['opus-5.5', 'claude'],
    },
    {
      name: "another provider without model: that provider's default model",
      provider: 'claude',
      want: [DEFAULT_MODEL, 'claude'],
    },
  ])('resolves run defaults with $name', async ({ model, provider, want }) => {
    mocks.projects.getProject.mockResolvedValue({
      ...baseProject,
      defaultProvider: 'codex',
      defaultModel: 'gpt-5.6-sol',
    });
    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      prompt: 'Go',
      model,
      provider,
    });
    expect(result.isOk()).toBe(true);
    const args = mocks.startAgent.mock.lastCall;
    expect([args?.[3], args?.[8]]).toEqual([...want]);
  });

  test.each([
    { name: 'project', projectId: 'p-1', isScratch: false },
    { name: 'scratch', projectId: null, isScratch: true },
  ])('never logs the prompt text for a $name thread (#182)', async ({ projectId, isScratch }) => {
    // A client-inlined `<referenced-files>` block sits at the front of the
    // prompt, so even a short preview would carry file contents.
    const prompt = '<referenced-files>\n<file path="secret.env">\nAPI_KEY=SECRET-VALUE\n';

    const result = await createAndStartThread({
      projectId,
      userId: 'u-1',
      mode: 'local',
      prompt,
      isScratch,
    });

    expect(result.isOk()).toBe(true);
    const metas = mocked(log.info).mock.calls.map((call) => JSON.stringify(call));
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) expect(meta).not.toContain('SECRET-VALUE');
  });

  test('executes initial ! commands locally without starting the agent', async () => {
    mocks.tm.insertMessage
      .mockResolvedValueOnce('msg-user-shell')
      .mockResolvedValueOnce('msg-assistant-shell');

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      prompt: '!printf "hello"',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('completed');
    }
    expect(mocks.startAgent).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixed-thread-id',
        projectId: 'p-1',
        status: 'completed',
        mode: 'local',
        branch: 'main',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        role: 'user',
        content: '!printf "hello"',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        role: 'assistant',
        content: '',
      }),
    );
    expect(mocks.tm.insertToolCall).toHaveBeenCalledWith({
      messageId: 'msg-assistant-shell',
      name: 'Bash',
      input: JSON.stringify({ command: 'printf "hello"' }),
      author: 'shell',
    });
    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith(
      'tc-shell',
      expect.stringContaining('hello'),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        cwd: '/projects/my-app',
        status: 'completed',
      }),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_output',
        threadId: 'fixed-thread-id',
        data: expect.objectContaining({
          toolCallId: 'tc-shell',
          output: expect.stringContaining('hello'),
        }),
      }),
    );
  });

  test('rejects initial bare ! shell escapes', async () => {
    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      prompt: '!',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(mocks.tm.createThread).not.toHaveBeenCalled();
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });

  test('creates scratch thread without project lookup and skips duplicate message insert', async () => {
    const result = await createAndStartThread({
      projectId: null,
      userId: 'u-1',
      mode: 'local',
      prompt: 'Try a regex',
      isScratch: true,
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.projects.getProject).not.toHaveBeenCalled();
    expect(mocks.projects.resolveProjectPath).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixed-thread-id',
        projectId: null,
        isScratch: 1,
        mode: 'local',
        status: 'pending',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
    expect(mocks.startAgent).toHaveBeenCalledWith(
      'fixed-thread-id',
      'Try a regex',
      '',
      'opus-4.8',
      'autoEdit',
      undefined,
      undefined,
      undefined,
      'claude',
      undefined,
      true,
      undefined,
    );
  });

  describe('staged uploads', () => {
    const stagedId = '0b6f4a8e-3c2d-4e5f-9a1b-2c3d4e5f6a7b';

    test('keeps staged files for a retry when the agent fails to start', async () => {
      mocks.adoptStagedUploads.mockReturnValue(
        okAsync([{ path: '.funny/uploads/fixed-thread-id/spec.pdf' }]),
      );
      mocks.startAgent.mockRejectedValueOnce(new Error('spawn failed'));

      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'local',
        prompt: 'Read it',
        stagedUploads: [stagedId],
      });

      expect(result.isErr()).toBe(true);
      expect(mocks.releaseStagedUploads).not.toHaveBeenCalled();
    });

    test('adopts staged files into the local cwd before creating the thread', async () => {
      mocks.adoptStagedUploads.mockReturnValue(
        okAsync([{ path: '.funny/uploads/fixed-thread-id/spec.pdf' }]),
      );
      const { augmentPromptWithFiles } = await import('../../utils/file-mentions.js');

      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'local',
        prompt: 'Read it',
        fileReferences: [{ path: 'src/a.ts' }],
        stagedUploads: [stagedId],
      });

      expect(result.isOk()).toBe(true);
      expect(mocks.adoptStagedUploads).toHaveBeenCalledWith({
        userId: 'u-1',
        stagedIds: [stagedId],
        cwd: '/projects/my-app',
        threadId: 'fixed-thread-id',
      });
      expect(augmentPromptWithFiles).toHaveBeenCalledWith(
        'Read it',
        [{ path: 'src/a.ts' }, { path: '.funny/uploads/fixed-thread-id/spec.pdf' }],
        '/projects/my-app',
      );
      // Released only once the create succeeded.
      expect(mocks.releaseStagedUploads).toHaveBeenCalledWith('u-1', [stagedId]);
    });

    test('fails with 400 and creates nothing when a staged file expired', async () => {
      mocks.adoptStagedUploads.mockReturnValue(
        errAsync({ type: 'BAD_REQUEST', message: 'An attached file expired or was not found.' }),
      );

      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'local',
        prompt: 'Read it',
        stagedUploads: [stagedId],
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.statusCode).toBe(400);
      expect(mocks.tm.createThread).not.toHaveBeenCalled();
      expect(mocks.startAgent).not.toHaveBeenCalled();
      expect(mocks.releaseStagedUploads).not.toHaveBeenCalled();
    });

    test('adopts into the scratch directory and inlines references for scratch threads', async () => {
      mocks.adoptStagedUploads.mockReturnValue(
        okAsync([{ path: '.funny/uploads/fixed-thread-id/notes.pdf' }]),
      );

      const result = await createAndStartThread({
        projectId: null,
        userId: 'u-1',
        mode: 'local',
        prompt: 'Summarize',
        isScratch: true,
        stagedUploads: [stagedId],
      });

      expect(result.isOk()).toBe(true);
      const cwd: string = mocks.adoptStagedUploads.mock.calls[0][0].cwd;
      expect(cwd).toMatch(/[\\/]\.funny[\\/]scratch[\\/]u-1[\\/]fixed-thread-id$/);
      expect(mocks.mkdir).toHaveBeenCalledWith(cwd, { recursive: true });
    });

    test('copies adopted uploads into the new worktree before starting the agent', async () => {
      mocks.adoptStagedUploads.mockReturnValue(
        okAsync([{ path: '.funny/uploads/fixed-thread-id/spec.pdf' }]),
      );
      mocks.copyThreadUploads.mockReturnValue(okAsync(undefined));
      mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
      mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));

      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'worktree',
        prompt: 'Read it',
        stagedUploads: [stagedId],
      });

      expect(result.isOk()).toBe(true);
      expect(mocks.adoptStagedUploads).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/projects/my-app' }),
      );
      await waitFor(() => expect(mocks.startAgent).toHaveBeenCalled());
      expect(mocks.copyThreadUploads).toHaveBeenCalledWith(
        '/projects/my-app',
        '/projects/my-app/.worktrees/feature',
        'fixed-thread-id',
      );
    });
  });

  test('creates worktree thread in setting_up and kicks off background setup', async () => {
    mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build the feature',
      title: 'New Feature',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('setting_up');
      expect(result.value.branch).toBe('my-app/new-feature-fixed-');
    }
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'worktree',
        status: 'setting_up',
        branch: 'my-app/new-feature-fixed-',
        // No explicit base: the worktree starts from the checkout's branch, and
        // it is recorded so git status can count the thread's commits.
        baseBranch: 'main',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        role: 'user',
        content: 'Build the feature',
      }),
    );
    expect(mocks.threadEventBus.emit).toHaveBeenCalledWith(
      'thread:created',
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        status: 'setting_up',
      }),
    );

    // Let the fire-and-forget worktree task run.
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.createWorktree).toHaveBeenCalledWith(
      '/projects/my-app',
      'my-app/new-feature-fixed-',
      'main',
      expect.any(Function),
      { reuseExistingBranch: false },
    );
    expect(mocks.setupWorktree).toHaveBeenCalledWith(
      '/projects/my-app',
      '/projects/my-app/.worktrees/feature',
      expect.any(Function),
    );
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'fixed-thread-id',
      expect.objectContaining({
        worktreePath: '/projects/my-app/.worktrees/feature',
        status: 'pending',
      }),
    );
    expect(mocks.startAgent).toHaveBeenCalled();
  });

  test('records no base branch for a worktree thread created from a detached HEAD', async () => {
    mocks.getCurrentBranch.mockResolvedValue(ok('HEAD'));
    mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));

    await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build the feature',
      title: 'New Feature',
    });

    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'worktree', baseBranch: undefined }),
    );
  });

  test('marks worktree thread failed when background createWorktree fails', async () => {
    mocks.createWorktree.mockResolvedValue(err(new Error('disk full')));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build',
      title: 'Feature',
    });

    expect(result.isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.tm.updateThread).toHaveBeenCalledWith('fixed-thread-id', { status: 'failed' });
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });

  describe('thread deleted while its worktree is prepared', () => {
    beforeEach(() => {
      mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
      mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));
      mocks.removeWorktree.mockReturnValue(okAsync(undefined));
      mocks.removeBranch.mockReturnValue(okAsync(undefined));
      mocks.tm.getThread.mockResolvedValueOnce(undefined);
    });

    test('removes the worktree and branch and does not start the agent', async () => {
      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'worktree',
        prompt: 'Build',
        title: 'Feature',
      });
      expect(result.isOk()).toBe(true);

      await waitFor(() => expect(mocks.removeBranch).toHaveBeenCalled());
      expect(mocks.removeWorktree).toHaveBeenCalledWith(
        '/projects/my-app',
        '/projects/my-app/.worktrees/feature',
      );
      expect(mocks.removeBranch).toHaveBeenCalledWith('/projects/my-app', 'my-app/feature-fixed-');
      expect(mocks.tm.updateThread).not.toHaveBeenCalled();
      expect(mocks.startAgent).not.toHaveBeenCalled();
    });

    test('keeps a reused branch, removing only the worktree', async () => {
      // The requested branch exists and no worktree has it checked out: reused.
      mocks.git.mockResolvedValue(ok('abc123'));
      mocks.findWorktreeForBranch.mockResolvedValue(ok(null));

      const result = await createAndStartThread({
        projectId: 'p-1',
        userId: 'u-1',
        mode: 'worktree',
        branch: 'factory/issue-1',
        prompt: 'Build',
        title: 'Feature',
      });
      expect(result.isOk()).toBe(true);

      await waitFor(() => expect(mocks.removeWorktree).toHaveBeenCalled());
      expect(mocks.removeBranch).not.toHaveBeenCalled();
      expect(mocks.startAgent).not.toHaveBeenCalled();
    });
  });

  test('continues worktree setup when postCreate commands report errors', async () => {
    mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: ['npm install failed'] }));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build',
      title: 'Feature',
    });

    expect(result.isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'fixed-thread-id',
      expect.objectContaining({ status: 'pending' }),
    );
    expect(mocks.startAgent).toHaveBeenCalled();
  });

  test('marks worktree thread failed when startAgent throws after setup', async () => {
    mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));
    mocks.startAgent.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build',
      title: 'Feature',
    });

    expect(result.isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.tm.updateThread).toHaveBeenCalledWith('fixed-thread-id', { status: 'failed' });
  });

  test('emits worktree:setup_complete after successful background setup', async () => {
    mocks.createWorktree.mockResolvedValue(ok('/projects/my-app/.worktrees/feature'));
    mocks.setupWorktree.mockResolvedValue(ok({ postCreateErrors: [] }));

    await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      prompt: 'Build',
      title: 'Feature',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'worktree:setup_complete',
        threadId: 'fixed-thread-id',
      }),
    );
  });

  test('rejects client-supplied worktreePath not registered for the project', async () => {
    mocks.isRegisteredWorktreePath.mockResolvedValueOnce(ok(false));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      worktreePath: '/etc/passwd',
      prompt: 'Evil',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('not registered');
    }
  });

  test('reuses an existing worktreePath and starts agent in that cwd', async () => {
    mocks.getCurrentBranch.mockResolvedValueOnce(ok('feature/wt'));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      worktreePath: '/projects/my-app/.worktrees/existing',
      prompt: 'Continue work',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/projects/my-app/.worktrees/existing',
        branch: 'feature/wt',
        status: 'pending',
      }),
    );
    expect(mocks.startAgent).toHaveBeenCalledWith(
      'fixed-thread-id',
      'Continue work',
      '/projects/my-app/.worktrees/existing',
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      undefined,
      'claude',
      undefined,
      undefined,
      undefined,
    );
  });

  test('accepts an externally registered worktreePath outside the managed worktree base', async () => {
    mocks.getCurrentBranch.mockResolvedValueOnce(ok('feature/external'));
    mocks.isRegisteredWorktreePath.mockResolvedValueOnce(ok(true));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      worktreePath: '/tmp/external-my-app-worktree',
      prompt: 'Continue external worktree',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.isRegisteredWorktreePath).toHaveBeenCalledWith(
      '/projects/my-app',
      '/tmp/external-my-app-worktree',
    );
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/tmp/external-my-app-worktree',
        branch: 'feature/external',
        status: 'pending',
      }),
    );
    expect(mocks.startAgent).toHaveBeenCalledWith(
      'fixed-thread-id',
      'Continue external worktree',
      '/tmp/external-my-app-worktree',
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      undefined,
      'claude',
      undefined,
      undefined,
      undefined,
    );
  });

  test('uses registered worktree for baseBranch instead of checking out inside supplied worktree', async () => {
    mocks.getCurrentBranch.mockResolvedValueOnce(ok('feature/current'));
    mocks.findWorktreeForBranch.mockResolvedValueOnce(ok('/tmp/existing-develop-worktree'));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'worktree',
      worktreePath: '/tmp/current-worktree',
      baseBranch: 'develop',
      prompt: 'Continue develop',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.git).not.toHaveBeenCalledWith(['checkout', 'develop'], expect.anything());
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/tmp/existing-develop-worktree',
        branch: 'develop',
        status: 'pending',
      }),
    );
    expect(mocks.startAgent).toHaveBeenCalledWith(
      'fixed-thread-id',
      'Continue develop',
      '/tmp/existing-develop-worktree',
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      undefined,
      'claude',
      undefined,
      undefined,
      undefined,
    );
  });

  test('starts a local thread without branch info when the current branch cannot be read', async () => {
    mocks.getCurrentBranch.mockResolvedValue(err(new Error('not a git repo')));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      baseBranch: 'develop',
      prompt: 'Work anyway',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.findWorktreeForBranch).not.toHaveBeenCalled();
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ branch: undefined, baseBranch: 'develop', status: 'pending' }),
    );
    expect(mocks.startAgent).toHaveBeenCalled();
  });

  test('checks out baseBranch in local mode when it differs from current branch', async () => {
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.git.mockResolvedValue(ok(undefined));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      baseBranch: 'develop',
      prompt: 'Work on develop',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.git).toHaveBeenCalledWith(['fetch', 'origin', 'develop'], '/projects/my-app');
    expect(mocks.git).toHaveBeenCalledWith(['checkout', 'develop'], '/projects/my-app');
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'develop' }),
    );
  });

  test('returns 400 when baseBranch checkout fails', async () => {
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.git
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err(new Error('branch missing')));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      baseBranch: 'missing-branch',
      prompt: 'Go',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('Failed to checkout branch');
    }
  });

  test('merges always-allow permission rules into allowedTools', async () => {
    mocks.listPermissionRules.mockResolvedValue([
      { toolName: 'Bash', decision: 'allow' },
      { toolName: 'Write', decision: 'deny' },
    ]);

    await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      prompt: 'Run tools',
      allowedTools: ['Read'],
    });

    expect(mocks.startAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      expect.arrayContaining(['Read', 'Bash']),
      expect.anything(),
      undefined,
      undefined,
      undefined,
    );
  });

  test('returns 400 for remote runtime without launcher URL', async () => {
    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      runtime: 'remote',
      prompt: 'Remote run',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(400);
      expect(result.error.message).toContain('launcher URL');
    }
  });

  test('launches remote container and forwards prompt in background', async () => {
    mocks.projects.getProject.mockResolvedValue({
      ...baseProject,
      launcherUrl: 'http://launcher:8080',
    });
    mocks.launchContainer.mockResolvedValue(
      ok({ containerUrl: 'http://container:3000', containerName: 'funny-t-fixed' }),
    );
    mocks.safeFetchUserUrl.mockResolvedValue({ ok: true, text: async () => '' });

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      runtime: 'remote',
      prompt: 'Remote run',
    });

    expect(result.isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.launchContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'fixed-thread-id',
        launcherUrl: 'http://launcher:8080',
        githubToken: 'gh-token',
      }),
    );
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'fixed-thread-id',
      expect.objectContaining({
        status: 'running',
        containerUrl: 'http://container:3000',
      }),
    );
    expect(mocks.safeFetchUserUrl).toHaveBeenCalledWith(
      'http://container:3000/api/threads',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('marks remote thread failed when container launch fails', async () => {
    mocks.projects.getProject.mockResolvedValue({
      ...baseProject,
      launcherUrl: 'http://launcher:8080',
    });
    mocks.launchContainer.mockResolvedValue(err(new Error('no capacity')));

    const result = await createAndStartThread({
      projectId: 'p-1',
      userId: 'u-1',
      mode: 'local',
      runtime: 'remote',
      prompt: 'Remote run',
    });

    expect(result.isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.tm.updateThread).toHaveBeenCalledWith('fixed-thread-id', { status: 'failed' });
  });
});
