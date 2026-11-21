import { describe, test, expect, vi, beforeEach, afterEach } from 'bun:test';

import type { IAgentProcess, ProcessOptionsSnapshot, StartAgentOptions } from '@funny/core/agents';
import type { Project, ResolvedAgentExecutionProfileResponse } from '@funny/shared';
import { mocked } from '@funny/test-kit';
import { err, ok } from 'neverthrow';

const noResolvedProfile: ResolvedAgentExecutionProfileResponse = { profile: null, env: {} };

const mocks = (() => ({
  orchestrator: {
    startAgent: vi.fn(async (_opts: StartAgentOptions) => undefined),
    stopAgent: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    cleanupThread: vi.fn(),
    adoptProcess: vi.fn(),
    extractActiveAgents: vi.fn(() => new Map()),
    extractActiveAgentSnapshot: vi.fn(() => ({
      agents: new Map<string, IAgentProcess>(),
      resultReceived: new Set<string>(),
      lastActivityAt: new Map<string, number>(),
      lastOptions: new Map<string, ProcessOptionsSnapshot>(),
    })),
  },
  threadManager: {
    getThread: vi.fn(),
    getThreadWithMessages: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => 'msg-1'),
  },
  state: {
    clearRunState: vi.fn(),
    cleanupThread: vi.fn(),
    threadUserIds: new Map<string, string>(),
    runDiffBaselines: new Map(),
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
  loadProjectMcpServers: vi.fn(async (..._args: unknown[]) => ({
    'test-server': { name: 'test-server' },
  })),
  resolveThreadCwd: vi.fn(),
  mkdirSync: vi.fn(),
  spanEnd: vi.fn(),
  startSpan: vi.fn(),
  clearThreadTrace: vi.fn(),
  setThreadTrace: vi.fn(),
  metric: vi.fn(),
  getProject: vi.fn(),
  getProviderKey: vi.fn(
    async (_userId?: string, _keyId?: string): Promise<string | undefined> => undefined,
  ),
  getGitIdentity: vi.fn(async (): Promise<{ name: string; email: string } | null> => null),
  resolveEffectiveProfile: vi.fn(async (): Promise<ResolvedAgentExecutionProfileResponse> => ({
    profile: null,
    env: {},
  })),
  threadEventBusEmit: vi.fn(),
  threadEventBusOn: vi.fn(),
  remoteGetAgentTemplate: vi.fn(),
  findPermissionRule: vi.fn(),
  runSensitivePathBypass: vi.fn(),
  syncClaudeProjectAssets: vi.fn(),
  captureGitCheckpoint: vi.fn(async (..._args: unknown[]) => undefined),
}))();

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

vi.mock('@funny/core/ports', () => ({
  syncClaudeProjectAssets: (...args: unknown[]) => mocks.syncClaudeProjectAssets(...args),
}));

vi.mock('../../services/agent-startup/recover-context.js', () => ({
  recoverThreadContext: (opts: any) => mocks.recoverThreadContext(opts),
}));

vi.mock('../../services/agent-startup/load-mcp-servers.js', () => ({
  loadProjectMcpServers: (...args: unknown[]) => mocks.loadProjectMcpServers(...args),
}));

const actualThreadContext = { ...(await import('../../services/thread-context.js')) };
vi.mock('../../services/thread-context.js', () => ({
  ...actualThreadContext,
  resolveThreadCwd: (...args: unknown[]) => mocks.resolveThreadCwd(...args),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: mocks.getProject },
    profile: {
      getProviderKey: mocks.getProviderKey,
      getGitIdentity: mocks.getGitIdentity,
    },
    agentProfiles: {
      resolveEffectiveProfile: mocks.resolveEffectiveProfile,
    },
  }),
}));

vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: {
    emit: (...args: unknown[]) => mocks.threadEventBusEmit(...args),
    on: (...args: unknown[]) => mocks.threadEventBusOn(...args),
  },
}));

vi.mock('../../services/remote-thread-data-client.js', () => ({
  remoteGetAgentTemplate: (...args: unknown[]) => mocks.remoteGetAgentTemplate(...args),
}));

vi.mock('../../services/permission-rules-client.js', () => ({
  findPermissionRule: (...args: unknown[]) => mocks.findPermissionRule(...args),
}));

vi.mock('../../services/sensitive-path-bypass.js', () => ({
  runSensitivePathBypass: (...args: unknown[]) => mocks.runSensitivePathBypass(...args),
}));

vi.mock('../../services/git-checkpoints.js', () => ({
  captureGitCheckpoint: (...args: unknown[]) => mocks.captureGitCheckpoint(...args),
}));

// startAgent loads these lazily (agent MCP servers, the browser bridge). Loading
// the real modules costs ~2.5 s inside the first test that starts an agent, which
// times out under load; no test here asserts on them.
vi.mock('../../services/agent-watch-tool.js', () => ({ FUNNY_MCP_SERVER: { name: 'funny' } }));
vi.mock('../../services/agent-mcp-http.js', () => ({
  grantAgentMcpHttp: (server: { name: string }) => ({
    type: 'http',
    url: `http://mcp/${server.name}`,
  }),
}));
vi.mock('../../services/browser-automation/browser-mcp-server.js', () => ({
  BROWSER_MCP_SERVER: { name: 'funny-browser' },
}));
vi.mock('../../services/browser-automation/open-url-bridge.js', () => ({
  browserOpenEnv: () => ({}),
}));

import { AgentOrchestrator } from '@funny/core/agents';

import { log } from '../../lib/logger.js';
import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentLifecycleManager } from '../../services/agent-lifecycle.js';
import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import type { RuntimeThreadRecord } from '../../services/server-interfaces.js';
import { scratchPathFor } from '../../services/thread-context.js';
import { cleanupThreadActor } from '../../services/thread-status-machine.js';
import { expectDefined, FakeAgentProcess, stubMethods } from '../helpers/builders-agents.js';
import {
  clearGlobal,
  createThreadManagerFake,
  createWsBrokerFake,
  readGlobal,
  writeGlobal,
} from '../helpers/builders.js';

/** Real collaborators whose methods the tests observe are replaced by `mocks`. */
function createManager(): AgentLifecycleManager {
  const orchestrator = stubMethods(
    new AgentOrchestrator({
      create: () => {
        throw new Error('the orchestrator is stubbed; no process is spawned');
      },
    }),
    mocks.orchestrator,
  );
  const threadManager = createThreadManagerFake(mocks.threadManager);
  const state = stubMethods(new AgentStateTracker(), mocks.state);
  const wsBroker = createWsBrokerFake();
  const eventRouter = stubMethods(
    new AgentEventRouter(
      orchestrator,
      state,
      new AgentMessageHandler(state, threadManager, wsBroker),
      threadManager,
      wsBroker,
    ),
    mocks.eventRouter,
  );
  return new AgentLifecycleManager(orchestrator, threadManager, state, eventRouter);
}

function lastStartAgentCall(): StartAgentOptions {
  return expectDefined(mocks.orchestrator.startAgent.mock.calls.at(-1)?.[0]);
}

function seedProjectThread(
  overrides: Partial<RuntimeThreadRecord> = {},
  projectOverrides: Partial<Project> = {},
) {
  const threadId = overrides.id ?? 'thread-1';
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
  mocks.resolveThreadCwd.mockImplementation((_thread, project: { path: string } | null) =>
    ok(project?.path ?? '/tmp/repo'),
  );
  return thread;
}

async function startWithStatus(
  status: string,
  overrides: Partial<RuntimeThreadRecord> = {},
  provider: 'claude' | 'deepagent' | 'gemini' | 'codex' = 'claude',
  projectOverrides: Partial<Project> = {},
) {
  const threadId = overrides.id ?? `thread-${status}-${provider}`;
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
  return lastStartAgentCall();
}

describe('AgentLifecycleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupThreadActor('thread-1');
    clearGlobal('__funnyActiveAgentSnapshot');
    clearGlobal('__funnyActiveAgents');
    mocks.orchestrator.startAgent.mockResolvedValue(undefined);
    mocks.remoteGetAgentTemplate.mockResolvedValue(undefined);
    mocks.getProviderKey.mockResolvedValue(undefined);
    mocks.findPermissionRule.mockResolvedValue(undefined);
    mocks.resolveEffectiveProfile.mockResolvedValue(noResolvedProfile);
    mocks.runSensitivePathBypass.mockResolvedValue({ output: 'bypassed' });
    mocks.startSpan.mockReturnValue({
      traceId: 'trace-1',
      spanId: 'span-1',
      end: mocks.spanEnd,
    });
    mocks.resolveThreadCwd.mockImplementation((_thread, project: { path: string } | null) =>
      ok(project?.path ?? '/tmp/repo'),
    );
  });

  afterEach(() => {
    clearGlobal('__funnyActiveAgentSnapshot');
    clearGlobal('__funnyActiveAgents');
  });

  describe('endRunSpan', () => {
    test('ends an active span, clears trace, and updates gauge metric', () => {
      const manager = createManager();
      manager.getRunSpans().set('thread-1', {
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'agent.run',
        attributes: {},
        durationMs: 0,
        end: mocks.spanEnd,
      });

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
      // No git in a scratch thread: no rewind checkpoint either.
      expect(mocks.captureGitCheckpoint).not.toHaveBeenCalled();
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
      // The workspace-prep throw must not leave the thread `running` (#195).
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        'scratch-2',
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  describe('startAgent — agent execution profile', () => {
    const workProfile = {
      id: 'profile-1',
      name: 'Work',
      provider: 'claude',
      config: { claude: { configDir: '/tmp/claude-work' } },
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    };

    test('merges the matching profile env and records it on the thread', async () => {
      mocks.resolveEffectiveProfile.mockResolvedValue({
        profile: workProfile,
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-work' },
      });

      const call = await startWithStatus('pending', { id: 'thread-profile-match' }, 'claude');

      expect(call.env).toEqual(expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tmp/claude-work' }));
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith('thread-profile-match', {
        agentProfileId: 'profile-1',
        agentProfileName: 'Work',
        agentProfileProvider: 'claude',
      });
    });

    test('ignores a profile for another provider and clears the recorded profile', async () => {
      mocks.resolveEffectiveProfile.mockResolvedValue({
        profile: workProfile,
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-work' },
      });

      const call = await startWithStatus('pending', { id: 'thread-profile-other' }, 'gemini');

      expect(call.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith('thread-profile-other', {
        agentProfileId: null,
        agentProfileName: null,
        agentProfileProvider: null,
      });
    });
  });

  describe('startAgent — project MCP profile', () => {
    test('loads project MCP servers from the active Claude profile config directory', async () => {
      seedProjectThread();
      mocks.resolveEffectiveProfile.mockResolvedValue({
        profile: {
          id: 'profile-1',
          name: 'Work',
          provider: 'claude',
          config: { claude: { configDir: '/tmp/claude-work' } },
          createdAt: '2026-06-24T00:00:00.000Z',
          updatedAt: '2026-06-24T00:00:00.000Z',
        },
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-work' },
      });

      const manager = createManager();
      await manager.startAgent('thread-1', 'hello', '/tmp/repo', 'sonnet', 'autoEdit');

      expect(mocks.resolveEffectiveProfile).toHaveBeenCalledWith('proj-1', 'user-1');
      expect(mocks.loadProjectMcpServers).toHaveBeenCalledWith('thread-1', '/tmp/repo', 'claude', {
        claudeConfigDir: '/tmp/claude-work',
        cwd: '/tmp/repo',
      });
    });
  });

  describe('startAgent — Git checkpoints', () => {
    test('captures a Git checkpoint for the newest user message before Codex starts', async () => {
      const thread = seedProjectThread();
      mocks.threadManager.getThreadWithMessages.mockResolvedValue({
        ...thread,
        messages: [
          { id: 'user-1', role: 'user' },
          { id: 'assistant-1', role: 'assistant' },
          { id: 'user-2', role: 'user' },
        ],
      });

      const manager = createManager();
      await manager.startAgent(
        'thread-1',
        'follow up',
        '/tmp/repo',
        'gpt-5.6-sol',
        'autoEdit',
        undefined,
        undefined,
        undefined,
        'codex',
      );

      expect(mocks.captureGitCheckpoint).toHaveBeenCalledWith({
        threadId: 'thread-1',
        messageId: 'user-2',
        cwd: '/tmp/repo',
      });
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith('thread-1', {
        fileCheckpointingEnabled: 1,
      });
    });

    test('captures a Git checkpoint before a Claude turn too', async () => {
      const thread = seedProjectThread();
      mocks.threadManager.getThreadWithMessages.mockResolvedValue({
        ...thread,
        messages: [{ id: 'user-1', role: 'user' }],
      });

      const manager = createManager();
      await manager.startAgent('thread-1', 'hello', '/tmp/repo', 'sonnet', 'autoEdit');

      expect(mocks.captureGitCheckpoint).toHaveBeenCalledWith({
        threadId: 'thread-1',
        messageId: 'user-1',
        cwd: '/tmp/repo',
      });
    });

    test('keeps rewind disabled when checkpoint capture fails', async () => {
      const thread = seedProjectThread();
      mocks.threadManager.getThreadWithMessages.mockResolvedValue({
        ...thread,
        messages: [{ id: 'user-1', role: 'user' }],
      });
      mocks.captureGitCheckpoint.mockRejectedValueOnce(new Error('not a Git worktree'));

      const manager = createManager();
      await manager.startAgent(
        'thread-1',
        'hello',
        '/tmp/repo',
        'gpt-5.6-sol',
        'autoEdit',
        undefined,
        undefined,
        undefined,
        'codex',
      );

      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith('thread-1', {
        fileCheckpointingEnabled: 0,
      });
      expect(mocks.orchestrator.startAgent).toHaveBeenCalled();
    });
  });

  describe('startAgent — cwd resolution failures', () => {
    test('syncs project Claude assets before starting a worktree thread', async () => {
      seedProjectThread({
        mode: 'worktree',
        worktreePath: '/tmp/repo/.worktrees/feature',
      });
      mocks.resolveThreadCwd.mockReturnValue(ok('/tmp/repo/.worktrees/feature'));

      const manager = createManager();
      await manager.startAgent('thread-1', 'hello', '/tmp/repo');

      expect(mocks.syncClaudeProjectAssets).toHaveBeenCalledWith(
        '/tmp/repo',
        '/tmp/repo/.worktrees/feature',
      );
      expect(mocks.orchestrator.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp/repo/.worktrees/feature' }),
      );
    });

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

  describe('startAgent — early start failures (#195)', () => {
    // A throw before launchAgent (here: the user-message insert) used to leave
    // the thread stuck `running`. The whole start now shares one failure path.
    test('marks thread failed when a start phase throws before the agent launches', async () => {
      seedProjectThread();
      mocks.threadManager.insertMessage.mockRejectedValueOnce(new Error('db write failed'));

      const manager = createManager();

      await expect(manager.startAgent('thread-1', 'hello', '/tmp/repo')).rejects.toThrow(
        'db write failed',
      );

      // The agent process must never have been handed off...
      expect(mocks.orchestrator.startAgent).not.toHaveBeenCalled();
      // ...and the thread must not be left `running`.
      expect(mocks.threadManager.updateThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(mocks.eventRouter.emitWSToUser).toHaveBeenCalledWith(
        'thread-1',
        'user-1',
        'agent:error',
        { error: 'db write failed' },
      );
      expect(mocks.eventRouter.emitWSToUser).toHaveBeenCalledWith(
        'thread-1',
        'user-1',
        'agent:status',
        { status: 'failed' },
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
      // Idle adds no resume prefix. The previewable-assets announcement is
      // always present for a user-owned thread, so systemPrefix is that block
      // alone rather than undefined.
      expect(call.systemPrefix).toEqual(expect.stringContaining('[PREVIEWABLE ASSETS]'));
      expect(call.systemPrefix).not.toMatch(/resume|follow-up|responded to your question/i);
    });
  });

  describe('startAgent — logging', () => {
    test('never logs the prompt body (it can inline attached file contents)', async () => {
      seedProjectThread();
      const manager = createManager();
      const secret = 'SECRET-FILE-CONTENTS-' + 'x'.repeat(200);

      await manager.startAgent('thread-1', `look at this\n${secret}`, '/tmp/repo');

      const calls: unknown[][] = mocked(log.info).mock.calls;
      const call = calls.find(([message]) => message === 'startAgent called');
      expect(call).toBeDefined();
      const meta = call?.[1];
      expect(JSON.stringify(meta)).not.toContain('SECRET-FILE-CONTENTS');
      expect(meta).not.toHaveProperty('promptFull');
      expect(meta).toHaveProperty('promptLength', `look at this\n${secret}`.length);
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

    test('keeps already-merged template tools when template variables are malformed', async () => {
      mocks.remoteGetAgentTemplate.mockResolvedValue({
        id: 'custom-template',
        name: 'Custom Agent',
        systemPrompt: 'Hello {{NAME}}',
        disallowedTools: JSON.stringify(['bash']),
        builtinSkillsDisabled: JSON.stringify(['search']),
      });

      const call = await startWithStatus(
        'pending',
        {
          agentTemplateId: 'custom-template',
          templateVariables: '{not-json',
          id: 'thread-deep-bad-vars',
        },
        'deepagent',
      );

      expect(mocks.orchestrator.startAgent).toHaveBeenCalled();
      expect(call.disallowedTools).toEqual(['bash']);
      expect(call.systemPrefix ?? '').not.toMatch(/\[AGENT TEMPLATE\]/);
      expect(call.builtinSkillsDisabled).toBeUndefined();
    });

    test('ignores template resolution for non-deepagent providers', async () => {
      const call = await startWithStatus(
        'pending',
        { agentTemplateId: '__builtin__code-reviewer', id: 'thread-deep-skip' },
        'claude',
      );

      expect(mocks.remoteGetAgentTemplate).not.toHaveBeenCalled();
      // No template prompt is injected for non-deepagent providers. (The always
      // -on previewable-assets block may still be present, so assert the absence
      // of the template marker rather than a fully undefined prefix.)
      expect(call.systemPrefix ?? '').not.toMatch(/\[AGENT TEMPLATE\]/);
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
        return keyId === undefined ? undefined : keys[keyId];
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

      const call = lastStartAgentCall();
      expect(call.env).toBeUndefined();
      expect(call.permissionRuleLookup).toBeUndefined();
      expect(mocks.getProviderKey).not.toHaveBeenCalled();
    });

    test('permissionRuleLookup returns persisted allow decision', async () => {
      mocks.findPermissionRule.mockResolvedValue({ decision: 'allow' });

      const call = await startWithStatus('pending', { id: 'thread-perm-allow' });
      const lookup = expectDefined(call.permissionRuleLookup);

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
      const lookup = expectDefined(call.permissionRuleLookup);

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
      const lookup = expectDefined(call.permissionRuleLookup);

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
      const bypass = expectDefined(call.bypassExecutor);

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

    test('redirects raw check commands unless the project turned it off', async () => {
      const byDefault = await startWithStatus(
        'pending',
        { id: 'thread-redirect-default' },
        'claude',
      );
      expect(byDefault.redirectChecks).toBe(true);

      const off = await startWithStatus('pending', { id: 'thread-redirect-off' }, 'claude', {
        redirectChecks: false,
      });
      expect(off.redirectChecks).toBe(false);
    });
  });

  describe('extractActiveAgents', () => {
    test('delegates to orchestrator', () => {
      const active = new Map([['t-1', new FakeAgentProcess('t-1')]]);
      mocks.orchestrator.extractActiveAgentSnapshot.mockReturnValue({
        agents: active,
        resultReceived: new Set<string>(),
        lastActivityAt: new Map<string, number>(),
        lastOptions: new Map<string, ProcessOptionsSnapshot>(),
      });

      const manager = createManager();
      expect(manager.extractActiveAgents()).toBe(active);
    });

    test('extractActiveAgentSnapshot delegates to orchestrator', () => {
      const snapshot = {
        agents: new Map([['t-1', new FakeAgentProcess('t-1')]]),
        resultReceived: new Set(['t-1']),
        lastActivityAt: new Map([['t-1', 123]]),
        lastOptions: new Map<string, ProcessOptionsSnapshot>(),
      };
      mocks.orchestrator.extractActiveAgentSnapshot.mockReturnValue(snapshot);

      const manager = createManager();
      expect(manager.extractActiveAgentSnapshot()).toBe(snapshot);
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
    test('adopts non-exited processes from snapshot on construction', () => {
      const proc = { exited: false };
      writeGlobal('__funnyActiveAgentSnapshot', {
        agents: new Map([['t-survive', proc]]),
        resultReceived: new Set(['t-survive']),
        lastActivityAt: new Map([['t-survive', 123]]),
        lastOptions: new Map([['t-survive', { provider: 'codex' }]]),
      });

      createManager();

      expect(mocks.orchestrator.adoptProcess).toHaveBeenCalledWith('t-survive', proc, {
        resultReceived: true,
        lastActivityAt: 123,
        lastOptions: { provider: 'codex' },
      });
      expect(readGlobal('__funnyActiveAgentSnapshot')).toBeUndefined();
      expect(readGlobal('__funnyActiveAgents')).toBeUndefined();
    });

    test('adopts legacy non-exited processes from globalThis on construction', () => {
      const proc = { exited: false };
      writeGlobal('__funnyActiveAgents', new Map([['t-survive', proc]]));

      createManager();

      expect(mocks.orchestrator.adoptProcess).toHaveBeenCalledWith('t-survive', proc, {
        resultReceived: undefined,
        lastActivityAt: undefined,
        lastOptions: undefined,
      });
    });

    test('marks interrupted when surviving process already exited', async () => {
      mocks.threadManager.getThread.mockResolvedValue({
        id: 't-dead',
        status: 'running',
      });
      writeGlobal('__funnyActiveAgents', new Map([['t-dead', { exited: true }]]));

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
