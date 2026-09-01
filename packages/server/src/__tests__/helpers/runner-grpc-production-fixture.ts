import type { WSEvent } from '@funny/shared';
import { GrpcEventReplayStore } from '@ironmussa/funny-runtime/services/grpc-event-replay-store';
import { GrpcOperationOutbox } from '@ironmussa/funny-runtime/services/grpc-operation-outbox';
import {
  GrpcTeamTransport,
  type GrpcTerminalCommand,
} from '@ironmussa/funny-runtime/services/grpc-team-transport';
import { GrpcTerminalReplayStore } from '@ironmussa/funny-runtime/services/grpc-terminal-replay-store';

import type { RunnerGrpcConfig } from '../../services/grpc/config.js';
import type {
  EventAcceptance,
  EventReceiptStore,
  EventScopeIdentity,
} from '../../services/grpc/event-receipts.js';
import type { AcceptedAgentEvent } from '../../services/grpc/events-handler.js';
import type {
  IdempotencyExecution,
  OperationIdempotencyStore,
} from '../../services/grpc/operation-idempotency.js';
import { type RunnerGrpcEndpoint } from '../../services/grpc/runner-grpc-server.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import {
  RunnerGrpcTerminalDispatcher,
  type GrpcTerminalBrowserEvent,
} from '../../services/grpc/terminal-handler.js';
import {
  RunnerGrpcTunnelDispatcher,
  type TunnelExchange,
} from '../../services/grpc/tunnel-handler.js';
import type { BrowserEventSink } from '../../services/runner-ports.js';
import { startRunnerServerComposition } from '../../services/runner-server-composition.js';

const TEST_CONFIG: RunnerGrpcConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxMessageBytes: 32 * 1024 * 1024,
  maxConcurrentStreamsPerRunner: 10,
  authTimeoutMs: 1_000,
  maxFrameBytes: 64 * 1024,
  maxPendingOperations: 32,
  idempotencyRetentionMs: 60_000,
  maxActiveTunnels: 4,
  maxActiveTerminals: 8,
  maxBufferedBytesPerClass: 1024 * 1024,
  heartbeatIntervalMs: 50,
  heartbeatTimeoutMs: 2_000,
};

class MemoryEventReceipts implements EventReceiptStore {
  private readonly accepted = new Map<string, { threadId: string; sequence: bigint }>();

  async highestAccepted(runnerId: string, executionId: string): Promise<bigint> {
    return this.accepted.get(`${runnerId}\0${executionId}`)?.sequence ?? 0n;
  }

  async accept(
    input: { runnerId: string; scope: EventScopeIdentity; sequence: bigint },
    apply: () => Promise<void>,
  ): Promise<EventAcceptance> {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    const current = this.accepted.get(key);
    const highest = current?.sequence ?? 0n;
    if (current && current.threadId !== input.scope.threadId) {
      throw new Error('event execution is already assigned to another thread');
    }
    if (input.sequence <= highest) {
      return { kind: 'duplicate', highestContiguousSequence: highest };
    }
    if (input.sequence !== highest + 1n) {
      return { kind: 'out_of_order', highestContiguousSequence: highest };
    }
    await apply();
    this.accepted.set(key, { threadId: input.scope.threadId, sequence: input.sequence });
    return { kind: 'accepted', highestContiguousSequence: input.sequence };
  }

  async resynchronize(
    input: {
      runnerId: string;
      scope: EventScopeIdentity;
      missingThroughSequence: bigint;
    },
    apply: () => Promise<void>,
  ): Promise<bigint> {
    await apply();
    this.accepted.set(`${input.runnerId}\0${input.scope.executionId}`, {
      threadId: input.scope.threadId,
      sequence: input.missingThroughSequence,
    });
    return input.missingThroughSequence;
  }
}

export class MemoryOperationIdempotency implements OperationIdempotencyStore {
  private readonly outcomes = new Map<string, { request: string; outcome: unknown }>();
  executionCount = 0;
  replayCount = 0;
  afterFirstExecution?: () => Promise<void>;

  async execute<T>(
    input: {
      runnerId: string;
      operationKind: string;
      idempotencyKey: string;
      request: unknown;
    },
    execute: () => Promise<T>,
  ): Promise<IdempotencyExecution<T>> {
    const key = `${input.runnerId}\0${input.operationKind}\0${input.idempotencyKey}`;
    const request = JSON.stringify(input.request);
    const existing = this.outcomes.get(key);
    if (existing) {
      if (existing.request !== request) return { kind: 'conflict' };
      this.replayCount += 1;
      return { kind: 'replayed', outcome: existing.outcome as T };
    }
    const outcome = await execute();
    this.executionCount += 1;
    this.outcomes.set(key, { request, outcome });
    if (this.afterFirstExecution) {
      const hook = this.afterFirstExecution;
      this.afterFirstExecution = undefined;
      await hook();
    }
    return { kind: 'executed', outcome };
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

export interface ProductionGrpcFixtureOptions {
  port?: number;
  config?: Partial<RunnerGrpcConfig>;
  outbox?: GrpcOperationOutbox;
  idempotency?: MemoryOperationIdempotency;
  executeOperation?: (request: Record<string, unknown>) => Promise<unknown>;
  handleTunnel?: (request: Request, signal: AbortSignal) => Promise<Response>;
  handleTerminal?: (command: GrpcTerminalCommand, respond: (event: WSEvent) => void) => void;
  browserEvents?: BrowserEventSink;
  runners?: Array<{
    runnerId: string;
    userId: string;
    token: string;
    handleTunnel?: (request: Request, signal: AbortSignal) => Promise<Response>;
    handleTerminal?: (command: GrpcTerminalCommand, respond: (event: WSEvent) => void) => void;
  }>;
}

export interface ProductionGrpcFixture {
  endpoint: RunnerGrpcEndpoint;
  transport: GrpcTeamTransport;
  transports: Map<string, GrpcTeamTransport>;
  outbox: GrpcOperationOutbox;
  idempotency: MemoryOperationIdempotency;
  events: AcceptedAgentEvent[];
  terminalEvents: WSEvent[];
  tunnelDispatcher: RunnerGrpcTunnelDispatcher;
  terminalDispatcher: RunnerGrpcTerminalDispatcher;
  dispatchTunnel(input: {
    method: string;
    path: string;
    headers?: Array<{ name: string; value: string }>;
    body?: Uint8Array;
  }): TunnelExchange;
  dispatchTerminal(userId: string, event: GrpcTerminalBrowserEvent): void;
  shutdown(): Promise<void>;
}

export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

export async function createProductionGrpcFixture(
  options: ProductionGrpcFixtureOptions = {},
): Promise<ProductionGrpcFixture> {
  const config = {
    ...TEST_CONFIG,
    ...options.config,
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  const sessions = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: config.heartbeatTimeoutMs });
  const terminalEvents: WSEvent[] = [];
  const events: AcceptedAgentEvent[] = [];
  const browserEvents = options.browserEvents ?? {
    toUser: () => {},
    toAll: () => {},
    toThreadStream: () => {},
    toThreadPresence: () => {},
    toThreadViewers: () => {},
    evictFromThread: () => {},
  };
  const tunnelDispatcher = new RunnerGrpcTunnelDispatcher(config, sessions);
  const terminalDispatcher = new RunnerGrpcTerminalDispatcher(config, sessions, (userId, event) => {
    terminalEvents.push(event as WSEvent);
    browserEvents.toUser(userId, event);
  });
  const idempotency = options.idempotency ?? new MemoryOperationIdempotency();
  const eventReceipts = new MemoryEventReceipts();
  const runnerDefinitions = options.runners ?? [
    {
      runnerId: 'runner-1',
      userId: 'user-1',
      token: 'runner-token',
      handleTunnel: options.handleTunnel,
      handleTerminal: options.handleTerminal,
    },
  ];
  const composition = await startRunnerServerComposition(browserEvents, {
    config,
    sessionRegistry: sessions,
    dependencies: {
      authenticateRunner: async (token) =>
        runnerDefinitions.find((runner) => runner.token === token)?.runnerId ?? null,
      getRunnerUserId: async (runnerId) =>
        runnerDefinitions.find((runner) => runner.runnerId === runnerId)?.userId ?? null,
    },
    operations: {
      idempotency,
      execute: async (_context, operation) =>
        options.executeOperation?.(operation.request) ?? {
          type: 'data:get_project_response',
          project: { id: 'project-1', name: 'Vertical project' },
        },
    },
    events: {
      receipts: eventReceipts,
      applyEvent: async (_context, event) => {
        events.push(event);
      },
    },
    tunnel: { dispatcher: tunnelDispatcher },
    terminal: { dispatcher: terminalDispatcher },
  });
  if (!composition) throw new Error('production gRPC fixture endpoint was disabled');
  const endpoint = composition.endpoint;

  const outbox = options.outbox ?? new GrpcOperationOutbox(':memory:');
  const transports = new Map<string, GrpcTeamTransport>();
  for (const [index, runner] of runnerDefinitions.entries()) {
    const transport = new GrpcTeamTransport({
      endpoint: `${endpoint.host}:${endpoint.port}`,
      token: runner.token,
      runner: {
        instanceId: runner.runnerId,
        name: `production-fixture-${runner.runnerId}`,
        hostname: 'fixture.local',
        operatingSystem: 'linux',
      },
      reconnectMinimumMs: 20,
      reconnectMaximumMs: 100,
      outbox: index === 0 ? outbox : new GrpcOperationOutbox(':memory:'),
      events: new GrpcEventReplayStore(':memory:'),
      terminals: new GrpcTerminalReplayStore(),
      handleTunnel:
        runner.handleTunnel ??
        (async (request) =>
          new Response(await request.text(), {
            status: 201,
            headers: { 'x-fixture': 'runtime' },
          })),
      handleTerminal:
        runner.handleTerminal ??
        ((command, respond) => {
          if (command.type === 'pty:write') {
            respond({
              type: 'pty:data',
              threadId: '',
              data: { ptyId: command.terminalId, data: 'terminal-ok' },
            });
          }
        }),
    });
    transports.set(runner.runnerId, transport);
    transport.start();
  }
  const transport = transports.get(runnerDefinitions[0]!.runnerId)!;
  await waitFor(
    () =>
      runnerDefinitions.every(
        ({ runnerId }) =>
          transports.get(runnerId)?.client.isActive() &&
          tunnelDispatcher.isConnected(runnerId) &&
          terminalDispatcher.isConnected(runnerId),
      ),
    'production runner adapters did not become ready',
  );

  return {
    endpoint,
    transport,
    transports,
    outbox,
    idempotency,
    events,
    terminalEvents,
    tunnelDispatcher,
    terminalDispatcher,
    dispatchTunnel: (input) =>
      tunnelDispatcher.dispatch('runner-1', {
        ...input,
        deadlineAt: Date.now() + 2_000,
      }),
    dispatchTerminal: (userId, event) => terminalDispatcher.dispatch('runner-1', userId, event),
    shutdown: async () => {
      for (const runnerTransport of transports.values()) {
        runnerTransport.shutdown('fixture shutdown');
      }
      await endpoint.shutdown(100);
    },
  };
}
