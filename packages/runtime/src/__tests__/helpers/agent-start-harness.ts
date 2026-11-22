/**
 * A real `AgentLifecycleManager` over in-memory state, for tests of what a
 * start does end to end: the thread row, the follow-up queue and the events a
 * client sees live here, and only the edges are faked (the process spawn, the
 * server data channel, telemetry, the filesystem `mkdirSync`, git).
 *
 * The module mocks below run when this file is imported, before the lifecycle
 * is loaded (dynamic import at the bottom). Import this module FIRST, and do
 * not import `agent-lifecycle.js` statically from a test that uses it. Tests run
 * with `bun test --parallel` (bunfig.toml), so the mocks stay in that file.
 */
import { mock, vi } from 'bun:test';

import type { StartAgentOptions } from '@funny/core/agents';
import type { ResolvedAgentExecutionProfileResponse } from '@funny/shared';

import type { HandlerServiceContext } from '../../services/handlers/types.js';
import type { RuntimeThreadRecord } from '../../services/server-interfaces.js';

export const edges = {
  /** The orchestrator's spawn: the only way a process could start. */
  spawn: vi.fn(async (_opts: StartAgentOptions) => undefined),
  mkdirSync: vi.fn((..._args: unknown[]) => undefined),
  getProject: vi.fn(async (_id: string): Promise<any> => undefined),
  getProjectSecrets: vi.fn(
    async (
      _threadId: string,
    ): Promise<{
      secrets?: { name: string; value: string }[];
      error?: string;
      message?: string;
    }> => ({
      secrets: [],
    }),
  ),
  resolveEffectiveProfile: vi.fn(async (): Promise<ResolvedAgentExecutionProfileResponse> => ({
    profile: null,
    env: {},
  })),
  getProviderKey: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  getDiffSummary: vi.fn((..._args: unknown[]) => ({
    match: (onOk: (s: { files: unknown[] }) => unknown) => onOk({ files: [] }),
  })),
  captureGitCheckpoint: vi.fn(async (..._args: unknown[]) => undefined),
  syncClaudeProjectAssets: vi.fn(),
  threadEventBusEmit: vi.fn(),
  spanEnd: vi.fn(),
  startSpan: vi.fn((..._args: unknown[]) => ({
    traceId: 'trace-1',
    spanId: 'span-1',
    end: edges.spanEnd,
  })),
};

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

mock.module('../../lib/telemetry.js', () => ({
  startSpan: (...args: unknown[]) => edges.startSpan(...args),
  clearThreadTrace: vi.fn(),
  setThreadTrace: vi.fn(),
  metric: vi.fn(),
}));

const actualFs = { ...(await import('node:fs')) };
mock.module('node:fs', () => ({
  ...actualFs,
  default: actualFs,
  mkdirSync: (...args: unknown[]) => edges.mkdirSync(...args),
}));

const actualGit = { ...(await import('@funny/core/git')) };
mock.module('@funny/core/git', () => ({
  ...actualGit,
  getDiffSummary: (...args: unknown[]) => edges.getDiffSummary(...args),
}));

mock.module('@funny/core/ports', () => ({
  syncClaudeProjectAssets: (...args: unknown[]) => edges.syncClaudeProjectAssets(...args),
}));

// Context recovery reads past messages from the server; a fresh start needs none.
mock.module('../../services/agent-startup/recover-context.js', () => ({
  recoverThreadContext: async ({ prompt, thread }: { prompt: string; thread?: any }) => ({
    effectivePrompt: prompt,
    effectiveSessionId: thread?.sessionId ?? undefined,
    needsRecovery: false,
  }),
}));

mock.module('../../services/agent-startup/load-mcp-servers.js', () => ({
  loadProjectMcpServers: vi.fn(async () => ({})),
}));

mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: (id: string) => edges.getProject(id) },
    profile: {
      getProviderKey: (...args: unknown[]) => edges.getProviderKey(...args),
      getGitIdentity: vi.fn(async () => null),
    },
    agentProfiles: { resolveEffectiveProfile: () => edges.resolveEffectiveProfile() },
  }),
}));

mock.module('../../services/thread-event-bus.js', () => ({
  threadEventBus: {
    emit: (...args: unknown[]) => edges.threadEventBusEmit(...args),
    on: vi.fn(),
  },
}));

mock.module('../../services/remote-thread-data-client.js', () => ({
  remoteGetAgentTemplate: vi.fn(async () => undefined),
}));
mock.module('../../services/permission-rules-client.js', () => ({
  findPermissionRule: vi.fn(async () => undefined),
}));
mock.module('../../services/sensitive-path-bypass.js', () => ({
  runSensitivePathBypass: vi.fn(async () => ({ output: '' })),
}));
mock.module('../../services/remote-project-identity-client.js', () => ({
  remoteGetProjectSecrets: (threadId: string) => edges.getProjectSecrets(threadId),
}));
mock.module('../../services/git-checkpoints.js', () => ({
  captureGitCheckpoint: (...args: unknown[]) => edges.captureGitCheckpoint(...args),
}));
mock.module('../../services/agent-watch-tool.js', () => ({ FUNNY_MCP_SERVER: { name: 'funny' } }));
mock.module('../../services/agent-mcp-http.js', () => ({
  grantAgentMcpHttp: (server: { name: string }) => ({
    type: 'http',
    url: `http://mcp/${server.name}`,
  }),
}));
mock.module('../../services/browser-automation/browser-mcp-server.js', () => ({
  BROWSER_MCP_SERVER: { name: 'funny-browser' },
}));
mock.module('../../services/browser-automation/open-url-bridge.js', () => ({
  browserOpenEnv: () => ({}),
}));

const { AgentOrchestrator } = await import('@funny/core/agents');
const { AgentEventRouter } = await import('../../services/agent-event-router.js');
const { AgentLifecycleManager } = await import('../../services/agent-lifecycle.js');
const { AgentMessageHandler } = await import('../../services/agent-message-handler.js');
const { AgentStateTracker } = await import('../../services/agent-state.js');
const { createThreadManagerFake, createWsBrokerFake } = await import('./builders.js');

/** A queued follow-up, shaped like the server's message-queue rows. */
export interface QueueEntry {
  id: string;
  threadId: string;
  content: string;
  provider: string | null;
  model: string | null;
  permissionMode: string | null;
  images: string | null;
  allowedTools: string | null;
  disallowedTools: string | null;
  fileReferences: string | null;
  sortOrder: number;
  createdAt: string;
}

/** A WS event the lifecycle sent to a thread's owner. */
export interface SentEvent {
  threadId: string;
  userId: string | undefined;
  type: string;
  data: any;
}

/**
 * One runner's worth of state: thread rows, the follow-up queue, the messages
 * a start inserted and the events it emitted, with a real lifecycle on top.
 */
export function createStartHarness() {
  const threads = new Map<string, RuntimeThreadRecord>();
  const queues = new Map<string, QueueEntry[]>();
  const insertedMessages: { threadId: string; content: string }[] = [];
  const events: SentEvent[] = [];
  let nextQueueId = 1;

  const threadManager = createThreadManagerFake({
    getThread: vi.fn(async (id: string) => {
      const row = threads.get(id);
      return row ? { ...row } : undefined;
    }),
    updateThread: vi.fn(async (id: string, updates: Record<string, any>) => {
      const row = threads.get(id);
      if (row) threads.set(id, { ...row, ...updates });
    }),
    insertMessage: vi.fn(async (data: { threadId: string; content: string }) => {
      insertedMessages.push({ threadId: data.threadId, content: data.content });
      return `msg-${insertedMessages.length}`;
    }),
    getThreadWithMessages: vi.fn(async () => null),
  });

  const orchestrator = Object.assign(
    new AgentOrchestrator({
      create: () => {
        throw new Error('the orchestrator is stubbed; no process is spawned');
      },
    }),
    {
      startAgent: (opts: StartAgentOptions) => edges.spawn(opts),
      isRunning: () => false,
    },
  );
  const state = new AgentStateTracker();
  const wsBroker = createWsBrokerFake();
  const eventRouter = Object.assign(
    new AgentEventRouter(
      orchestrator,
      state,
      new AgentMessageHandler(state, threadManager, wsBroker),
      threadManager,
      wsBroker,
    ),
    {
      emitWSToUser: (threadId: string, userId: string | undefined, type: string, data: any) => {
        events.push({ threadId, userId, type, data });
      },
    },
  );
  const lifecycle = new AgentLifecycleManager(orchestrator, threadManager, state, eventRouter);

  function enqueue(threadId: string, content: string, extra: Partial<QueueEntry> = {}) {
    const list = queues.get(threadId) ?? [];
    const entry: QueueEntry = {
      id: `q-${nextQueueId++}`,
      threadId,
      content,
      provider: null,
      model: null,
      permissionMode: null,
      images: null,
      allowedTools: null,
      disallowedTools: null,
      fileReferences: null,
      sortOrder: list.length,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    list.push(entry);
    queues.set(threadId, list);
    return entry;
  }

  /** The handler context `init-runtime.ts` builds, over this harness's state. */
  const handlerCtx: HandlerServiceContext = {
    getThread: (id) => threadManager.getThread(id) as any,
    updateThread: (id, updates) => threadManager.updateThread(id, updates),
    insertComment: vi.fn(),
    getProject: (id) => edges.getProject(id),
    emitToUser: vi.fn(),
    broadcast: vi.fn(),
    startAgent: (
      threadId,
      prompt,
      cwd,
      model,
      permissionMode,
      images,
      disallowedTools,
      allowedTools,
      provider,
      skipMessageInsert,
    ) =>
      lifecycle.startAgent(
        threadId,
        prompt,
        cwd,
        model as any,
        permissionMode as any,
        images,
        disallowedTools,
        allowedTools,
        provider as any,
        undefined,
        skipMessageInsert,
      ),
    getGitStatusSummary: vi.fn(),
    deriveGitSyncState: vi.fn(),
    invalidateGitStatusCache: vi.fn(),
    saveThreadEvent: vi.fn(async () => {}),
    dequeueMessage: async (threadId) => queues.get(threadId)?.shift() ?? null,
    enqueueMessage: async (threadId, entry) =>
      enqueue(threadId, entry.content, {
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        permissionMode: entry.permissionMode ?? null,
        images: entry.images ?? null,
        allowedTools: entry.allowedTools ?? null,
        disallowedTools: entry.disallowedTools ?? null,
        fileReferences: entry.fileReferences ?? null,
      }),
    queueCount: async (threadId) => queues.get(threadId)?.length ?? 0,
    peekMessage: async (threadId) => queues.get(threadId)?.[0] ?? null,
    log: vi.fn(),
  };

  return {
    lifecycle,
    state,
    threads,
    queues,
    insertedMessages,
    events,
    handlerCtx,
    enqueue,
    seedThread(row: Partial<RuntimeThreadRecord> & { id: string }) {
      const full = {
        userId: 'user-1',
        projectId: 'proj-1',
        status: 'completed',
        mode: 'local',
        sessionId: null,
        cost: 0,
        model: 'sonnet',
        provider: 'claude',
        permissionMode: 'autoEdit',
        worktreePath: null,
        ...row,
      } as RuntimeThreadRecord;
      threads.set(row.id, full);
      return full;
    },
    eventsOf(threadId: string, type: string) {
      return events.filter((e) => e.threadId === threadId && e.type === type);
    },
  };
}

/** Put every edge back to a working default (`clearAllMocks` keeps implementations). */
export function resetEdges(): void {
  vi.clearAllMocks();
  edges.spawn.mockImplementation(async () => undefined);
  edges.mkdirSync.mockImplementation(() => undefined);
  edges.getProject.mockImplementation(async () => undefined);
  edges.getProjectSecrets.mockImplementation(async () => ({ secrets: [] }));
  edges.resolveEffectiveProfile.mockImplementation(async () => ({ profile: null, env: {} }));
  edges.getProviderKey.mockImplementation(async () => undefined);
}
