import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest';

const lifecycleMock = vi.hoisted(() => ({
  stopAllAgents: vi.fn(async () => undefined),
  extractActiveAgents: vi.fn(() => new Map<string, unknown>()),
  startAgent: vi.fn(async () => undefined),
  stopAgent: vi.fn(async () => undefined),
  isAgentRunning: vi.fn(() => false),
  cleanupThreadState: vi.fn(),
  getRunSpans: vi.fn(() => new Map()),
  endRunSpan: vi.fn(),
}));

const shutdownCapture = vi.hoisted(() => ({
  handler: null as null | ((mode: 'hotReload' | 'hard') => Promise<void>),
}));

vi.mock('../../services/shutdown-manager.js', () => ({
  shutdownManager: {
    register: (name: string, fn: (mode: 'hotReload' | 'hard') => Promise<void>) => {
      if (name === 'agent-runner') shutdownCapture.handler = fn;
    },
  },
  ShutdownPhase: { SERVICES: 1 },
}));

vi.mock('../../services/agent-lifecycle.js', () => ({
  AgentLifecycleManager: vi.fn(function AgentLifecycleManager() {
    return lifecycleMock;
  }),
}));

vi.mock('../../services/agent-event-router.js', () => ({
  AgentEventRouter: vi.fn(function AgentEventRouter() {
    return {
      setSpanContext: vi.fn(),
    };
  }),
}));

vi.mock('../../services/agent-message-handler.js', () => ({
  AgentMessageHandler: vi.fn(function AgentMessageHandler() {
    return {};
  }),
}));

vi.mock('../../services/agent-state.js', () => ({
  AgentStateTracker: vi.fn(function AgentStateTracker() {
    return { startAutoSweep: vi.fn() };
  }),
}));

vi.mock('../../services/remote-thread-manager.js', () => ({
  createRemoteThreadManager: () => ({}),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
}));

vi.mock('@funny/core', () => ({
  setLogSink: vi.fn(),
}));

vi.mock('@funny/core/agents', () => ({
  AgentOrchestrator: vi.fn(function AgentOrchestrator() {
    return {};
  }),
  defaultProcessFactory: {},
}));

describe('AgentRunner shutdown handler', () => {
  beforeAll(async () => {
    vi.resetModules();
    await import('../../services/agent-runner.js');
    if (!shutdownCapture.handler) {
      throw new Error('agent-runner shutdown handler was not registered');
    }
  });

  afterEach(() => {
    delete (globalThis as any).__funnyActiveAgents;
    vi.clearAllMocks();
  });

  test('hotReload preserves active agents on globalThis when any are running', async () => {
    const surviving = new Map([['t-1', { threadId: 't-1' }]]);
    lifecycleMock.extractActiveAgents.mockReturnValue(surviving);

    await shutdownCapture.handler!('hotReload');

    expect((globalThis as any).__funnyActiveAgents).toBe(surviving);
    expect(lifecycleMock.stopAllAgents).not.toHaveBeenCalled();
  });

  test('hotReload stops all agents when none are active', async () => {
    lifecycleMock.extractActiveAgents.mockReturnValue(new Map());

    await shutdownCapture.handler!('hotReload');

    expect(lifecycleMock.stopAllAgents).toHaveBeenCalled();
    expect((globalThis as any).__funnyActiveAgents).toBeUndefined();
  });

  test('hard shutdown always stops all agents', async () => {
    lifecycleMock.extractActiveAgents.mockReturnValue(new Map([['t-1', {}]]));

    await shutdownCapture.handler!('hard');

    expect(lifecycleMock.stopAllAgents).toHaveBeenCalled();
    expect((globalThis as any).__funnyActiveAgents).toBeUndefined();
  });
});
