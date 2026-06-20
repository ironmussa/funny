import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    createThread: vi.fn(async () => undefined),
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
  startAgent: vi.fn(async () => undefined),
  getCurrentBranch: vi.fn(),
  createWorktree: vi.fn(),
  setupWorktree: vi.fn(),
  git: vi.fn(),
  checkWorktreePathInProject: vi.fn(() => null),
  launchContainer: vi.fn(),
  safeFetchUserUrl: vi.fn(),
  listPermissionRules: vi.fn(async () => []),
  executeShellEscape: vi.fn(async (command: string) => ({
    command,
    stdout: 'hello',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  })),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
}));

vi.mock('nanoid', () => ({ nanoid: () => 'fixed-thread-id' }));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: mocks.projects, profile: mocks.profile }),
}));

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: mocks.threadEventBus,
}));

vi.mock('../../services/agent-runner-control.js', () => ({
  startAgent: mocks.startAgent,
}));

vi.mock('../../services/permission-rules-client.js', () => ({
  listPermissionRules: mocks.listPermissionRules,
}));

vi.mock('../../services/podman-service.js', () => ({
  launchContainer: mocks.launchContainer,
}));

vi.mock('../../lib/ssrf-guard.js', () => ({
  safeFetchUserUrl: mocks.safeFetchUserUrl,
}));

vi.mock('../../utils/file-mentions.js', () => ({
  augmentPromptWithFiles: vi.fn(async (content: string) => content),
  augmentPromptWithSymbols: vi.fn(async (content: string) => content),
  stripInlineReferencedContent: vi.fn((content: string) => content),
}));

vi.mock('../../services/thread-service/shell-escape.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/thread-service/shell-escape.js')>();
  return {
    ...actual,
    executeShellEscape: mocks.executeShellEscape,
  };
});

vi.mock('@funny/core/git', () => ({
  getCurrentBranch: mocks.getCurrentBranch,
  createWorktree: mocks.createWorktree,
  git: mocks.git,
  checkWorktreePathInProject: mocks.checkWorktreePathInProject,
}));

vi.mock('@funny/core/ports', () => ({
  setupWorktree: mocks.setupWorktree,
}));

import { ok, err } from 'neverthrow';

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
      undefined,
      expect.any(Function),
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

  test('rejects client-supplied worktreePath outside project scope', async () => {
    mocks.checkWorktreePathInProject.mockReturnValueOnce({ message: 'path outside project' });

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
      expect(result.error.message).toContain('path outside project');
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
