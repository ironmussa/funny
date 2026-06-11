import { err, ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  orchestrator: {
    startAgent: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    cleanupThread: vi.fn(),
    adoptProcess: vi.fn(),
    extractActiveAgents: vi.fn(() => new Map()),
  },
  threadManager: {
    getThread: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => 'msg-1'),
  },
  state: {
    clearRunState: vi.fn(),
    cleanupThread: vi.fn(),
    threadUserIds: new Map<string, string>(),
  },
  eventRouter: {
    emitWSToUser: vi.fn(),
    clearQueue: vi.fn(),
    destroy: vi.fn(),
  },
  recoverThreadContext: vi.fn(
    async ({
      prompt,
      thread,
    }: {
      prompt: string;
      thread?: { sessionId?: string | null } | null;
    }) => ({
      effectivePrompt: prompt,
      effectiveSessionId: thread?.sessionId ?? undefined,
      needsRecovery: false,
    }),
  ),
  loadProjectMcpServers: vi.fn(async () => ({ 'test-server': { name: 'test-server' } })),
  resolveThreadCwd: vi.fn(),
  mkdirSync: vi.fn(),
  spanEnd: vi.fn(),
  startSpan: vi.fn(),
  clearThreadTrace: vi.fn(),
  setThreadTrace: vi.fn(),
  metric: vi.fn(),
  getProject: vi.fn(),
  getProviderKey: vi.fn(async () => undefined),
  getGitIdentity: vi.fn(async (): Promise<{ name: string; email: string } | null> => null),
  threadEventBusEmit: vi.fn(),
  threadEventBusOn: vi.fn(),
  remoteGetAgentTemplate: vi.fn(),
  findPermissionRule: vi.fn(),
  runSensitivePathBypass: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/telemetry.js', () => ({
  startSpan: (...args: unknown[]) => mocks.startSpan(...args),
  clearThreadTrace: (...args: unknown[]) => mocks.clearThreadTrace(...args),
  setThreadTrace: (...args: unknown[]) => mocks.setThreadTrace(...args),
  metric: (...args: unknown[]) => mocks.metric(...args),
}));

vi.mock('node:fs', () => ({
  mkdirSync: (...args: unknown[]) => mocks.mkdirSync(...args),
}));

vi.mock('../../services/agent-startup/recover-context.js', () => ({
  recoverThreadContext: (...args: unknown[]) => mocks.recoverThreadContext(...args),
}));

vi.mock('../../services/agent-startup/load-mcp-servers.js', () => ({
  loadProjectMcpServers: (...args: unknown[]) => mocks.loadProjectMcpServers(...args),
}));

vi.mock('../../services/thread-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/thread-context.js')>();
  return {
    ...actual,
    resolveThreadCwd: (...args: unknown[]) => mocks.resolveThreadCwd(...args),
  };
});

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: mocks.getProject },
    profile: {
      getProviderKey: mocks.getProviderKey,
      getGitIdentity: mocks.getGitIdentity,
    },
  }),
}));

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: {
    emit: (...args: unknown[]) => mocks.threadEventBusEmit(...args),
    on: (...args: unknown[]) => mocks.threadEventBusOn(...args),
  },
}));

vi.mock('../../services/team-client.js', () => ({
  remoteGetAgentTemplate: (...args: unknown[]) => mocks.remoteGetAgentTemplate(...args),
}));

vi.mock('../../services/permission-rules-client.js', () => ({
  findPermissionRule: (...args: unknown[]) => mocks.findPermissionRule(...args),
}));

vi.mock('../../services/sensitive-path-bypass.js', () => ({
  runSensitivePathBypass: (...args: unknown[]) => mocks.runSensitivePathBypass(...args),
}));

import { log } from '../../lib/logger.js';
import { AgentLifecycleManager } from '../../services/agent-lifecycle.js';
import { scratchPathFor } from '../../services/thread-context.js';
import { cleanupThreadActor } from '../../services/thread-status-machine.js';

function createManager(): AgentLifecycleManager {
  return new AgentLifecycleManager(
    mocks.orchestrator as never,
    mocks.threadManager as never,
    mocks.state as never,
    mocks.eventRouter as never,
  );
}

function seedProjectThread(
  overrides: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {},
) {
  const threadId = (overrides.id as string) ?? 'thread-1';
  const thread = {
    id: threadId,
    userId: 'user-1',
    projectId: 'proj-1',
    status: 'pending',
    mode: 'local',
    sessionId: null,
    cost: 0,
    ...overrides,
  };
  mocks.threadManager.getThread.mockResolvedValue(thread);
  mocks.getProject.mockResolvedValue({
    id: 'proj-1',
    path: '/tmp/repo',
    systemPrompt: null,
    ...projectOverrides,
  });
  mocks.resolveThreadCwd.mockImplementation((_thread, project) =>
    ok((project as { path: string } | null)?.path ?? '/tmp/repo'),
  );
  return thread;
}

async function startWithStatus(
  status: string,
  overrides: Record<string, unknown> = {},
  provider: 'claude' | 'deepagent' | 'gemini' | 'codex' = 'claude',
  projectOverrides: Record<string, unknown> = {},
) {
  const threadId = (overrides.id as string) ?? `thread-${status}-${provider}`;
  cleanupThreadActor(threadId);
  seedProjectThread({ id: threadId, status, ...overrides }, projectOverrides);
  const manager = createManager();
  await manager.startAgent(
    threadId,
    'hello',
    '/tmp/repo',
    'sonnet',
    'autoEdit',
    undefined,
    undefined,
    undefined,
    provider,
  );
  return mocks.orchestrator.startAgent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('AgentLifecycleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupThreadActor('thread-1');
    delete (globalThis as { __funnyActiveAgents?: unknown }).__funnyActiveAgents;
    mocks.orchestrator.startAgent.mockResolvedValue(undefined);
    mocks.remoteGetAgentTemplate.mockResolvedValue(undefined);
    mocks.getProviderKey.mockResolvedValue(undefined);
    mocks.findPermissionRule.mockResolvedValue(undefined);
    mocks.runSensitivePathBypass.mockResolvedValue({ output: 'bypassed' });
    mocks.startSpan.mockReturnValue({
      traceId: 'trace-1',
      spanId: 'span-1',
      end: mocks.spanEnd,
    });
    mocks.resolveThreadCwd.mockImplementation((_thread, project) =>
      ok((project as { path: string } | null)?.path ?? '/tmp/repo'),
    );
  });

  afterEach(() => {
    delete (globalThis as { __funnyActiveAgents?: unknown }).__funnyActiveAgents;
  });

  describe('endRunSpan', () => {
    test('ends an active span, clears trace, and updates gauge metric', () => {
      const manager = createManager();
      manager.getRunSpans().set('thread-1', {
        traceId: 'trace-1',
        spanId: 'span-1',
        end: mocks.spanEnd,
      } as never);

      manager.endRunSpan('thread-1', 'error', 'boom');

      expect(mocks.spanEnd).toHaveBeenCalledWith('error', 'boom');
      expect(manager.getRunSpans().has('thread-1')).toBe(false);
      expect(mocks.clearThreadTrace).toHaveBeenCalledWith('thread-1');
      expect(mocks.metric).toHaveBeenCalledWith('agents.running', 0, { type: 'gauge' });
    });

    test('still clears trace when no span is registered', () => {
      const manager = createManager();

      manager.endRunSpan('missing-thread', 'ok');

      expect(mocks.spanEnd).not.toHaveBeenCalled();
      expect(mocks.clearThreadTrace).toHaveBeenCalledWith('missing-thread');
    });
  });

  describe('startAgent — cold path recovery', () => {
    test('marks process_lost when non-claude provider resumes a stale session', async () => {
      seedProjectThread({
        status: 'completed',
        sessionId: 'sess-stale',
      });
      mocks.orchestrator.isRunning.mockReturnValue(false);

      const manager = createManager();
      await manager.startAgent(
        'thread-1',
        'follow up',
        '/tmp/repo',
        'sonnet',
        'autoEdit',
        undefined,
        undefined,
        undefined,
        'gemini',
      );

      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ contextRecoveryReason: 'process_lost' }),
      );
      expect(mocks.orchestrator.startAgent).toHaveBeenCalled();
    });

    test('skips cold-path recovery for claude provider with existing session', async () => {
      seedProjectThread({
        status: 'completed',
        sessionId: 'sess-claude',
      });
      mocks.orchestrator.isRunning.mockReturnValue(false);

      const manager = createManager();
      await manager.startAgent(
        'thread-1',
        'follow up',
        '/tmp/repo',
        'sonnet',
        'autoEdit',
        undefined,
        undefined,
        undefined,
        'claude',
      );

      expect(mocks.threadManager.updateThread).not.toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ contextRecoveryReason: 'process_lost' }),
      );
    });
  });

  describe('startAgent — scratch threads', () => {
    test('creates scratch directory and skips project MCP loading', async () => {
      const scratchCwd = scratchPathFor('user-1', 'scratch-1');
      mocks.threadManager.getThread.mockResolvedValue({
        id: 'scratch-1',
        userId: 'user-1',
        projectId: '',
        isScratch: true,
        status: 'pending',
        mode: 'local',
        sessionId: null,
        cost: 0,
      });
      mocks.getProject.mockResolvedValue(null);
      mocks.resolveThreadCwd.mockReturnValue(ok(scratchCwd));

      const manager = createManager();
      await manager.startAgent('scratch-1', 'try regex', '/ignored', 'sonnet');

      expect(mocks.mkdirSync).toHaveBeenCalledWith(scratchCwd, { recursive: true });
      expect(mocks.loadProjectMcpServers).not.toHaveBeenCalled();
      expect(mocks.orchestrator.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: scratchCwd }),
      );
      expect(mocks.threadEventBusEmit).toHaveBeenCalledWith(
        'agent:started',
        expect.objectContaining({ threadId: 'scratch-1', cwd: scratchCwd }),
      );
    });

    test('fails scratch start when mkdirSync throws', async () => {
      const scratchCwd = scratchPathFor('user-1', 'scratch-2');
      mocks.threadManager.getThread.mockResolvedValue({
        id: 'scratch-2',
        userId: 'user-1',
        isScratch: true,
        status: 'pending',
        mode: 'local',
        sessionId: null,
        cost: 0,
      });
      mocks.resolveThreadCwd.mockReturnValue(ok(scratchCwd));
      mocks.mkdirSync.mockImplementation(() => {
        throw new Error('permission denied');
      });

      const manager = createManager();

      await expect(manager.startAgent('scratch-2', 'hello', '/ignored')).rejects.toThrow(
        'permission denied',
      );
      expect(mocks.orchestrator.startAgent).not.toHaveBeenCalled();
    });
  });

  describe('startAgent — cwd resolution failures', () => {
    test('marks thread failed and emits error when cwd cannot be resolved', async () => {
      seedProjectThread({ mode: 'worktree', worktreePath: null });
      mocks.resolveThreadCwd.mockReturnValue(
        err({ kind: 'worktree-missing', message: 'Worktree thread thread-1 has no worktreePath' }),
      );

      const manager = createManager();
      await manager.startAgent('thread-1', 'hello', '/tmp/repo');

      expect(mocks.orchestrator.startAgent).not.toHaveBeenCalled();
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mocks.eventRouter.emitWSToUser).toHaveBeenCalledWith(
        'thread-1',
        'user-1',
        'agent:error',
        expect.objectContaining({ error: expect.stringContaining('worktreePath') }),
      );
      expect(mocks.eventRouter.emitWSToUser).toHaveBeenCalledWith(
        'thread-1',
        'user-1',
        'agent:status',
        { status: 'failed' },
      );
    });
  });

  describe('startAgent — orchestrator errors', () => {
    test('ends run span and marks thread failed when orchestrator start throws', async () => {
      seedProjectThread();
      mocks.orchestrator.startAgent.mockRejectedValue(new Error('spawn failed'));

      const manager = createManager();

      await expect(manager.startAgent('thread-1', 'hello', '/tmp/repo')).rejects.toThrow(
        'spawn failed',
      );

      expect(mocks.spanEnd).toHaveBeenCalledWith('error', 'spawn failed');
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mocks.eventRouter.emitWSToUser).toHaveBeenCalledWith(
        'thread-1',
        'user-1',
        'agent:error',
        { error: 'spawn failed' },
      );
    });
  });

  describe('startAgent — pickStartEvent resume prefixes', () => {
    test.each([
      ['waiting', 'responded to your question'],
      ['completed', 'follow-up message after your previous work completed'],
      ['interrupted', 'session resume after an interruption'],
      ['stopped', 'session resume after an interruption'],
      ['failed', 'session resume after an interruption'],
    ] as const)('uses %s status resume prefix', async (status, snippet) => {
      const call = await startWithStatus(status);
      expect(call.systemPrefix).toEqual(expect.stringContaining(snippet));
    });

    test('idle status falls back to START without resume prefix', async () => {
      const call = await startWithStatus('idle');
      expect(call.systemPrefix).toBeUndefined();
    });
  });

  describe('startAgent — message and project prompt', () => {
    test('skips user message insert when skipMessageInsert is true', async () => {
      seedProjectThread();
      const manager = createManager();

      await manager.startAgent(
        'thread-1',
        'hello',
        '/tmp/repo',
        'sonnet',
        'autoEdit',
        undefined,
        undefined,
        undefined,
        'claude',
        undefined,
        true,
      );

      expect(mocks.threadManager.insertMessage).not.toHaveBeenCalled();
    });

    test('prepends project instructions to prompt when there is no session id', async () => {
      const call = await startWithStatus(
        'pending',
        { sessionId: null, id: 'thread-project-prompt' },
        'claude',
        { systemPrompt: 'Always run tests' },
      );
      expect(call.prompt).toEqual(
        expect.stringContaining(
          '[PROJECT INSTRUCTIONS]\nAlways run tests\n[/PROJECT INSTRUCTIONS]',
        ),
      );
    });

    test('uses post-merge resume prefix when mergedAt is set', async () => {
      const call = await startWithStatus('completed', {
        mergedAt: '2025-01-01T00:00:00.000Z',
        id: 'thread-post-merge',
      });
      expect(call.systemPrefix).toEqual(
        expect.stringContaining('follow-up after your previous work was merged'),
      );
    });
  });

  describe('startAgent — deep agent templates', () => {
    test('resolves builtin template tools and system prefix for deepagent', async () => {
      const call = await startWithStatus(
        'pending',
        { agentTemplateId: '__builtin__code-reviewer', id: 'thread-deep-builtin' },
        'deepagent',
      );

      expect(mocks.remoteGetAgentTemplate).not.toHaveBeenCalled();
      expect(call.disallowedTools).toEqual(
        expect.arrayContaining(['write_file', 'edit_file', 'execute']),
      );
      expect(call.systemPrefix).toEqual(
        expect.stringContaining('[AGENT TEMPLATE]\nYou are a code reviewer'),
      );
      expect(call.systemPrefix).toEqual(expect.stringContaining('[/AGENT TEMPLATE]'));
    });

    test('loads remote template, interpolates variables, and wires runtime fields', async () => {
      mocks.remoteGetAgentTemplate.mockResolvedValue({
        id: 'custom-template',
        name: 'Custom Agent',
        systemPrompt: 'Hello {{NAME}} from {{MISSING}}',
        systemPromptMode: 'prepend',
        disallowedTools: JSON.stringify(['bash']),
        mcpServers: JSON.stringify([{ name: 'remote-mcp', command: 'node' }]),
        builtinSkillsDisabled: JSON.stringify(['search']),
        customSkillPaths: JSON.stringify(['/skills/custom']),
        agentName: 'custom-agent',
      });

      const call = await startWithStatus(
        'pending',
        {
          agentTemplateId: 'custom-template',
          templateVariables: { NAME: 'Funny' },
          id: 'thread-deep-remote',
        },
        'deepagent',
      );

      expect(mocks.remoteGetAgentTemplate).toHaveBeenCalledWith('custom-template');
      expect(call.disallowedTools).toEqual(['bash']);
      expect(call.mcpServers).toEqual(
        expect.objectContaining({
          'test-server': { name: 'test-server' },
          'remote-mcp': { name: 'remote-mcp', command: 'node' },
        }),
      );
      expect(call.systemPrefix).toEqual(
        expect.stringContaining('[AGENT TEMPLATE]\nHello Funny from {{MISSING}}'),
      );
      expect(call.builtinSkillsDisabled).toEqual(['search']);
      expect(call.customSkillPaths).toEqual(['/skills/custom']);
      expect(call.agentName).toBe('custom-agent');
    });

    test('continues startup when remote template lookup fails', async () => {
      mocks.remoteGetAgentTemplate.mockRejectedValue(new Error('network down'));

      const call = await startWithStatus(
        'pending',
        { agentTemplateId: 'broken-template', id: 'thread-deep-fail' },
        'deepagent',
      );

      expect(call.prompt).toBe('hello');
      expect(mocks.orchestrator.startAgent).toHaveBeenCalled();
    });

    test('ignores template resolution for non-deepagent providers', async () => {
      const call = await startWithStatus(
        'pending',
        { agentTemplateId: '__builtin__code-reviewer', id: 'thread-deep-skip' },
        'claude',
      );

      expect(mocks.remoteGetAgentTemplate).not.toHaveBeenCalled();
      expect(call.systemPrefix).toBeUndefined();
      expect(call.disallowedTools).toBeUndefined();
    });
  });

  describe('startAgent — provider env and permission hooks', () => {
    test('injects provider API keys into agent env for gemini', async () => {
      mocks.getProviderKey.mockImplementation(async (_userId, keyId) =>
        keyId === 'gemini' ? 'gemini-secret' : undefined,
      );

      const call = await startWithStatus('pending', { id: 'thread-env-gemini' }, 'gemini');

      expect(mocks.getProviderKey).toHaveBeenCalledWith('user-1', 'gemini');
      expect(call.env).toEqual({ GEMINI_API_KEY: 'gemini-secret' });
    });

    test('injects multiple deepagent keys when configured', async () => {
      mocks.getProviderKey.mockImplementation(async (_userId, keyId) => {
        const keys: Record<string, string> = {
          gemini: 'gemini-key',
          openai: 'openai-key',
          minimax: 'minimax-key',
        };
        return keys[keyId as string];
      });

      const call = await startWithStatus('pending', { id: 'thread-env-deepagent' }, 'deepagent');

      expect(call.env).toEqual({
        GEMINI_API_KEY: 'gemini-key',
        OPENAI_API_KEY: 'openai-key',
        MINIMAX_API_KEY: 'minimax-key',
      });
    });

    test('omits env when provider keys are not configured', async () => {
      const call = await startWithStatus('pending', { id: 'thread-env-empty' }, 'codex');

      expect(mocks.getProviderKey).toHaveBeenCalledWith('user-1', 'openai');
      expect(call.env).toBeUndefined();
    });

    test('injects git identity env vars from user profile', async () => {
      mocks.getGitIdentity.mockResolvedValue({
        name: 'Argenis Leon',
        email: 'argenis@example.com',
      });

      const call = await startWithStatus('pending', { id: 'thread-git-identity' });

      expect(mocks.getGitIdentity).toHaveBeenCalledWith('user-1');
      expect(call.env).toEqual({
        GIT_AUTHOR_NAME: 'Argenis Leon',
        GIT_AUTHOR_EMAIL: 'argenis@example.com',
        GIT_COMMITTER_NAME: 'Argenis Leon',
        GIT_COMMITTER_EMAIL: 'argenis@example.com',
      });
    });

    test('merges git identity env with provider keys', async () => {
      mocks.getProviderKey.mockImplementation(async (_userId, keyId) =>
        keyId === 'gemini' ? 'gemini-secret' : undefined,
      );
      mocks.getGitIdentity.mockResolvedValue({
        name: 'Argenis Leon',
        email: 'argenis@example.com',
      });

      const call = await startWithStatus('pending', { id: 'thread-env-both' }, 'gemini');

      expect(call.env).toEqual({
        GEMINI_API_KEY: 'gemini-secret',
        GIT_AUTHOR_NAME: 'Argenis Leon',
        GIT_AUTHOR_EMAIL: 'argenis@example.com',
        GIT_COMMITTER_NAME: 'Argenis Leon',
        GIT_COMMITTER_EMAIL: 'argenis@example.com',
      });
    });

    test('skips env injection and permission lookup when thread has no userId', async () => {
      cleanupThreadActor('thread-no-user');
      seedProjectThread({ id: 'thread-no-user', userId: undefined });
      const manager = createManager();

      await manager.startAgent('thread-no-user', 'hello', '/tmp/repo');

      const call = mocks.orchestrator.startAgent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(call.env).toBeUndefined();
      expect(call.permissionRuleLookup).toBeUndefined();
      expect(mocks.getProviderKey).not.toHaveBeenCalled();
    });

    test('permissionRuleLookup returns persisted allow decision', async () => {
      mocks.findPermissionRule.mockResolvedValue({ decision: 'allow' });

      const call = await startWithStatus('pending', { id: 'thread-perm-allow' });
      const lookup = call.permissionRuleLookup as (query: {
        toolName: string;
        toolInput?: string;
      }) => Promise<{ decision: string } | null>;

      await expect(lookup({ toolName: 'Bash', toolInput: 'ls -la' })).resolves.toEqual({
        decision: 'allow',
      });
      expect(mocks.findPermissionRule).toHaveBeenCalledWith({
        userId: 'user-1',
        projectPath: '/tmp/repo',
        toolName: 'Bash',
        toolInput: 'ls -la',
      });
    });

    test('permissionRuleLookup uses worktree path when present', async () => {
      mocks.resolveThreadCwd.mockReturnValue(ok('/tmp/repo/.worktrees/feature'));
      mocks.findPermissionRule.mockResolvedValue({ decision: 'deny' });

      const call = await startWithStatus('pending', {
        id: 'thread-perm-worktree',
        mode: 'worktree',
        worktreePath: '/tmp/repo/.worktrees/feature',
      });
      const lookup = call.permissionRuleLookup as (query: {
        toolName: string;
      }) => Promise<{ decision: string } | null>;

      await lookup({ toolName: 'Write' });

      expect(mocks.findPermissionRule).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: '/tmp/repo/.worktrees/feature',
          toolName: 'Write',
        }),
      );
    });

    test('permissionRuleLookup returns null when lookup fails', async () => {
      mocks.findPermissionRule.mockRejectedValue(new Error('tunnel down'));

      const call = await startWithStatus('pending', { id: 'thread-perm-fail' });
      const lookup = call.permissionRuleLookup as (query: { toolName: string }) => Promise<null>;

      await expect(lookup({ toolName: 'Read' })).resolves.toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        'permissionRuleLookup failed',
        expect.objectContaining({
          namespace: 'agent',
          threadId: 'thread-perm-fail',
          toolName: 'Read',
          error: 'tunnel down',
        }),
      );
    });

    test('bypassExecutor delegates to sensitive path bypass helper', async () => {
      mocks.runSensitivePathBypass.mockResolvedValue({ output: 'written' });

      const call = await startWithStatus('pending', { id: 'thread-bypass' });
      const bypass = call.bypassExecutor as (query: {
        toolName: string;
        toolInput: unknown;
        cwd?: string;
      }) => Promise<{ output: string }>;

      await expect(
        bypass({ toolName: 'Write', toolInput: { file_path: '/home/.claude/settings.json' } }),
      ).resolves.toEqual({ output: 'written' });
      expect(mocks.runSensitivePathBypass).toHaveBeenCalledWith({
        toolName: 'Write',
        toolInput: { file_path: '/home/.claude/settings.json' },
        cwd: '/tmp/repo',
      });
    });
  });

  describe('startAgent — project settings', () => {
    test('forwards fastMode from project to orchestrator', async () => {
      const call = await startWithStatus('pending', { id: 'thread-fastmode-on' }, 'claude', {
        fastMode: true,
      });

      expect(call.fastMode).toBe(true);
    });

    test('defaults fastMode to false when project has it disabled', async () => {
      const call = await startWithStatus('pending', { id: 'thread-fastmode-off' }, 'claude', {
        fastMode: false,
      });

      expect(call.fastMode).toBe(false);
    });

    test('defaults fastMode to false when project omits the field', async () => {
      const call = await startWithStatus('pending', { id: 'thread-fastmode-default' }, 'claude');

      expect(call.fastMode).toBe(false);
    });
  });

  describe('extractActiveAgents', () => {
    test('delegates to orchestrator', () => {
      const active = new Map([['t-1', { threadId: 't-1' }]]);
      mocks.orchestrator.extractActiveAgents.mockReturnValue(active);

      const manager = createManager();
      expect(manager.extractActiveAgents()).toBe(active);
    });
  });

  describe('stop / cleanup helpers', () => {
    test('stopAgent no-ops for external provider threads', async () => {
      mocks.threadManager.getThread.mockResolvedValue({ provider: 'external' });

      const manager = createManager();
      await manager.stopAgent('external-1');

      expect(mocks.orchestrator.stopAgent).not.toHaveBeenCalled();
    });

    test('stopAgent delegates to orchestrator for normal threads', async () => {
      mocks.threadManager.getThread.mockResolvedValue({ provider: 'claude' });

      const manager = createManager();
      await manager.stopAgent('thread-1');

      expect(mocks.orchestrator.stopAgent).toHaveBeenCalledWith('thread-1');
    });

    test('cleanupThreadState clears orchestrator, state, and event queue', () => {
      const manager = createManager();
      manager.cleanupThreadState('thread-1');

      expect(mocks.orchestrator.cleanupThread).toHaveBeenCalledWith('thread-1');
      expect(mocks.state.cleanupThread).toHaveBeenCalledWith('thread-1');
      expect(mocks.eventRouter.clearQueue).toHaveBeenCalledWith('thread-1');
    });

    test('isAgentRunning delegates to orchestrator', () => {
      mocks.orchestrator.isRunning.mockReturnValue(true);

      const manager = createManager();
      expect(manager.isAgentRunning('thread-1')).toBe(true);
    });

    test('stopAllAgents destroys router and stops orchestrator', async () => {
      const manager = createManager();
      await manager.stopAllAgents();

      expect(mocks.eventRouter.destroy).toHaveBeenCalled();
      expect(mocks.orchestrator.stopAll).toHaveBeenCalled();
    });
  });

  describe('adoptSurvivingProcesses', () => {
    test('adopts non-exited processes from globalThis on construction', () => {
      const proc = { exited: false };
      (globalThis as { __funnyActiveAgents?: Map<string, unknown> }).__funnyActiveAgents = new Map([
        ['t-survive', proc],
      ]);

      createManager();

      expect(mocks.orchestrator.adoptProcess).toHaveBeenCalledWith('t-survive', proc);
      expect((globalThis as { __funnyActiveAgents?: unknown }).__funnyActiveAgents).toBeUndefined();
    });

    test('marks interrupted when surviving process already exited', async () => {
      mocks.threadManager.getThread.mockResolvedValue({
        id: 't-dead',
        status: 'running',
      });
      (globalThis as { __funnyActiveAgents?: Map<string, unknown> }).__funnyActiveAgents = new Map([
        ['t-dead', { exited: true }],
      ]);

      createManager();
      await new Promise((r) => setTimeout(r, 0));

      expect(mocks.orchestrator.adoptProcess).not.toHaveBeenCalled();
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        't-dead',
        expect.objectContaining({ status: 'interrupted' }),
      );
    });
  });
});
