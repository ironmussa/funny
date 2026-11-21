/**
 * Real collaborators for the agent event router / message handler tests.
 *
 * The router and handler take concrete classes (`AgentOrchestrator`,
 * `AgentMessageHandler`); these build real instances with inert dependencies
 * so a test spies on the methods it cares about instead of casting a partial
 * literal.
 */

import { vi } from 'bun:test';

import { AgentOrchestrator, type CLIMessage } from '@funny/core/agents';
import type { ThreadStatus } from '@funny/shared';

import { AgentMessageHandler, type ProjectLookup } from '../../services/agent-message-handler.js';
import type { AgentStateTracker } from '../../services/agent-state.js';
import type { HandlerServiceContext } from '../../services/handlers/types.js';
import type { IThreadManager, IWSBroker } from '../../services/server-interfaces.js';
import type { AgentCompletedEvent } from '../../services/thread-event-bus.js';
import { createThreadManagerFake, createWsBrokerFake } from './builders.js';

/** An orchestrator that never spawns a process; emit its events with `.emit(...)`. */
export function createOrchestrator(): AgentOrchestrator {
  return new AgentOrchestrator({
    create: () => {
      throw new Error('tests do not spawn agent processes');
    },
  });
}

export function createMessageHandler(
  state: AgentStateTracker,
  threadManager: IThreadManager = createThreadManagerFake(),
  wsBroker: IWSBroker = createWsBrokerFake(),
  getProject?: ProjectLookup,
): AgentMessageHandler {
  return new AgentMessageHandler(state, threadManager, wsBroker, getProject);
}

/**
 * A CLI message exactly as it arrives off the wire, for shapes the typed
 * `CLIMessage` union does not model (the handler must still tolerate them).
 */
export function wireMessage(json: string): CLIMessage {
  return JSON.parse(json);
}

/**
 * A status `AgentCompletedEvent` does not allow, for tests that check a
 * handler ignores a non-terminal status if one ever reaches it.
 */
export function nonTerminalStatus(status: ThreadStatus): AgentCompletedEvent['status'] {
  // SAFETY: deliberately out-of-contract input; the only caller is a test asserting the handler ignores it.
  return status as AgentCompletedEvent['status'];
}

/** A handler context whose every service is a `vi.fn()` with a neutral result. */
export function createHandlerContext(
  overrides: Partial<HandlerServiceContext> = {},
): HandlerServiceContext {
  return {
    getThread: vi.fn(async () => undefined),
    getProject: vi.fn(async () => undefined),
    dequeueMessage: vi.fn(async () => null),
    enqueueMessage: vi.fn(async () => ({})),
    queueCount: vi.fn(async () => 0),
    peekMessage: vi.fn(async () => null),
    startAgent: vi.fn(async () => undefined),
    emitToUser: vi.fn(),
    broadcast: vi.fn(),
    log: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    insertComment: vi.fn(async () => undefined),
    getGitStatusSummary: vi.fn(),
    deriveGitSyncState: vi.fn(),
    invalidateGitStatusCache: vi.fn(),
    saveThreadEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}
