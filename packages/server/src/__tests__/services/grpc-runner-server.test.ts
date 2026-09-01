import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { createSqliteDatabase } from '@funny/shared/db/connection';
import { RunnerCapability } from '@funny/shared/runner-v2/common';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

import { resolveRunnerGrpcConfig } from '../../services/grpc/config.js';
import type { EventReceiptStore } from '../../services/grpc/event-receipts.js';
import { SqlOperationIdempotencyStore } from '../../services/grpc/operation-idempotency.js';
import {
  startRunnerGrpcEndpoint,
  type RunnerGrpcEndpoint,
  type RunnerGrpcHandler,
} from '../../services/grpc/runner-grpc-server.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';

const protocolRoot = resolve(import.meta.dir, '..', '..', '..', '..', '..', 'protocol');

type TestClient = grpc.Client & {
  control(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
  operations(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
  events(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
  tunnel(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
  terminal(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>;
};

let endpoint: RunnerGrpcEndpoint | null = null;
let client: TestClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await endpoint?.shutdown(100);
  endpoint = null;
});

function config(overrides: Partial<ReturnType<typeof resolveRunnerGrpcConfig>> = {}) {
  return {
    ...resolveRunnerGrpcConfig({ RUNNER_GRPC_ENABLED: 'true' }),
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  };
}

function createClient(port: number): TestClient {
  const definition = loadSync(resolve(protocolRoot, 'runner', 'v2', 'control.proto'), {
    defaults: false,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
    includeDirs: [protocolRoot],
  });
  const root = grpc.loadPackageDefinition(definition) as grpc.GrpcObject;
  const runner = root.runner as grpc.GrpcObject;
  const v2 = runner.v2 as grpc.GrpcObject;
  const Constructor = v2.RunnerTransportService as grpc.ServiceClientConstructor;
  return new Constructor(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  ) as unknown as TestClient;
}

function metadata(token?: string, correlationId?: string): grpc.Metadata {
  const result = new grpc.Metadata();
  if (token) result.set('authorization', `Bearer ${token}`);
  if (correlationId) result.set('x-correlation-id', correlationId);
  return result;
}

function statusOf<Request, Response>(
  stream: grpc.ClientDuplexStream<Request, Response>,
): Promise<grpc.StatusObject> {
  stream.once('error', () => {});
  return new Promise((resolveStatus) => stream.once('status', resolveStatus));
}

function nextMessage(
  stream: grpc.ClientDuplexStream<Record<string, unknown>, Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    stream.once('data', resolveMessage);
    stream.once('error', reject);
  });
}

function operationDeadline(offsetMs = 10_000): {
  seconds: string;
  nanos: number;
} {
  const timestamp = Date.now() + offsetMs;
  return {
    seconds: String(Math.floor(timestamp / 1_000)),
    nanos: (timestamp % 1_000) * 1_000_000,
  };
}

function operationRequest(
  operation: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session: { sessionEpoch: '1' },
    metadata: { correlationId: 'operation-1', deadline: operationDeadline() },
    ...operation,
    ...overrides,
  };
}

function runnerHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supportedVersions: [{ major: 2, minor: 0 }],
    runner: {
      instanceId: 'instance-1',
      name: 'runner-1',
      hostname: 'runner.example',
      operatingSystem: 'linux',
    },
    capabilities: [
      'RUNNER_CAPABILITY_OPERATIONS',
      'RUNNER_CAPABILITY_EVENTS',
      'RUNNER_CAPABILITY_HTTP_TUNNEL',
    ],
    ...overrides,
  };
}

class MemoryEventReceiptStore implements EventReceiptStore {
  private readonly cursors = new Map<string, bigint>();

  constructor(initial: Record<string, bigint> = {}) {
    for (const [executionId, sequence] of Object.entries(initial)) {
      this.cursors.set(`runner-1\0${executionId}`, sequence);
    }
  }

  async highestAccepted(runnerId: string, executionId: string): Promise<bigint> {
    return this.cursors.get(`${runnerId}\0${executionId}`) ?? 0n;
  }

  async accept(
    input: {
      runnerId: string;
      scope: { threadId: string; executionId: string };
      sequence: bigint;
    },
    apply: () => Promise<void>,
  ) {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    const highestContiguousSequence = this.cursors.get(key) ?? 0n;
    if (input.sequence <= highestContiguousSequence) {
      return { kind: 'duplicate' as const, highestContiguousSequence };
    }
    if (input.sequence !== highestContiguousSequence + 1n) {
      return { kind: 'out_of_order' as const, highestContiguousSequence };
    }
    await apply();
    this.cursors.set(key, input.sequence);
    return {
      kind: 'accepted' as const,
      highestContiguousSequence: input.sequence,
    };
  }

  async resynchronize(
    input: {
      runnerId: string;
      scope: { threadId: string; executionId: string };
      missingThroughSequence: bigint;
    },
    apply: () => Promise<void>,
  ): Promise<bigint> {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    const highest = this.cursors.get(key) ?? 0n;
    if (input.missingThroughSequence <= highest) return highest;
    await apply();
    this.cursors.set(key, input.missingThroughSequence);
    return input.missingThroughSequence;
  }
}

describe('runner gRPC endpoint configuration', () => {
  test('is enabled by default and can be explicitly disabled', async () => {
    expect(resolveRunnerGrpcConfig({})).toMatchObject({
      enabled: true,
      maxMessageBytes: 32 * 1024 * 1024,
    });
    expect(
      await startRunnerGrpcEndpoint({
        config: resolveRunnerGrpcConfig({ RUNNER_GRPC_ENABLED: 'false' }),
      }),
    ).toBeNull();
  });

  test('rejects invalid numeric limits', () => {
    expect(() =>
      resolveRunnerGrpcConfig({
        RUNNER_GRPC_ENABLED: 'true',
        RUNNER_GRPC_MAX_STREAMS_PER_RUNNER: '0',
      }),
    ).toThrow('RUNNER_GRPC_MAX_STREAMS_PER_RUNNER must be a positive integer');

    expect(() =>
      resolveRunnerGrpcConfig({
        RUNNER_GRPC_MAX_MESSAGE_BYTES: '1024',
        RUNNER_GRPC_MAX_FRAME_BYTES: '2048',
      }),
    ).toThrow('RUNNER_GRPC_MAX_FRAME_BYTES must not exceed RUNNER_GRPC_MAX_MESSAGE_BYTES');

    expect(() =>
      resolveRunnerGrpcConfig({
        RUNNER_GRPC_HEARTBEAT_INTERVAL_MS: '1000',
        RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS: '1000',
      }),
    ).toThrow('RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS must exceed RUNNER_GRPC_HEARTBEAT_INTERVAL_MS');
  });
});

describe('runner gRPC transport boundary', () => {
  test('authenticates bearer metadata and derives principal without trusting payloads', async () => {
    let received:
      | {
          token: string;
          runnerId: string;
          userId: string | null;
          correlationId: string;
        }
      | undefined;
    const accepted = Promise.withResolvers<void>();
    const control: RunnerGrpcHandler = (call, context) => {
      received = {
        token: 'good-token',
        runnerId: context.principal.runnerId,
        userId: context.principal.userId,
        correlationId: context.correlationId,
      };
      accepted.resolve();
      call.end();
    };
    let authenticatedToken = '';
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async (token) => {
          authenticatedToken = token;
          return token === 'good-token' ? 'runner-1' : null;
        },
        getRunnerUserId: async () => 'user-1',
      },
      handlers: { control },
    });
    expect(endpoint).not.toBeNull();
    client = createClient(endpoint!.port);

    const stream = client.control(metadata('good-token', 'request-123'));
    stream.write({ claimedUserId: 'attacker-user' });
    await accepted.promise;

    expect(authenticatedToken).toBe('good-token');
    expect(received).toEqual({
      token: 'good-token',
      runnerId: 'runner-1',
      userId: 'user-1',
      correlationId: 'request-123',
    });
  });

  test('rejects missing and revoked credentials with UNAUTHENTICATED', async () => {
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => null,
        getRunnerUserId: async () => null,
      },
    });
    client = createClient(endpoint!.port);

    const missing = client.control(metadata());
    const missingStatus = statusOf(missing);
    missing.write({});
    expect((await missingStatus).code).toBe(grpc.status.UNAUTHENTICATED);

    const revoked = client.control(metadata('revoked-token'));
    const revokedStatus = statusOf(revoked);
    revoked.write({});
    expect((await revokedStatus).code).toBe(grpc.status.UNAUTHENTICATED);
  });

  test('enforces the shared per-runner stream limit across communication classes', async () => {
    const firstAccepted = Promise.withResolvers<void>();
    const holdOpen: RunnerGrpcHandler = () => firstAccepted.resolve();
    endpoint = await startRunnerGrpcEndpoint({
      config: config({ maxConcurrentStreamsPerRunner: 1 }),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      handlers: { control: holdOpen, operations: holdOpen },
    });
    client = createClient(endpoint!.port);

    const control = client.control(metadata('good-token'));
    control.write({});
    await firstAccepted.promise;

    const operations = client.operations(metadata('good-token'));
    const limitedStatus = statusOf(operations);
    operations.write({});
    expect((await limitedStatus).code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    const cancelledStatus = statusOf(control);
    control.cancel();
    await cancelledStatus;
  });

  test('replaces unsafe caller correlation values before invoking handlers', async () => {
    const observed = Promise.withResolvers<string>();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      handlers: {
        control: (call, context) => {
          observed.resolve(context.correlationId);
          call.end();
        },
      },
    });
    client = createClient(endpoint!.port);

    const unsafe = 'secret correlation value';
    const stream = client.control(metadata('good-token', unsafe));
    stream.write({});
    expect(await observed.promise).not.toBe(unsafe);
  });
});

describe('runner gRPC control negotiation', () => {
  test('accepts a proto3-default minor omitted by the Buf runner', async () => {
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.control(metadata('good-token'));
    const response = nextMessage(stream);

    stream.write({
      hello: runnerHello({ supportedVersions: [{ major: 2 }] }),
    });

    expect(await response).toMatchObject({
      message: 'hello',
      hello: { selectedVersion: { major: 2, minor: 0 } },
    });
    stream.end();
  });

  test('negotiates the highest version, capabilities, limits, heartbeat, and resume cursors', async () => {
    endpoint = await startRunnerGrpcEndpoint({
      config: config({
        maxMessageBytes: 1_024,
        maxFrameBytes: 512,
        maxPendingOperations: 8,
        maxActiveTunnels: 3,
        maxActiveTerminals: 4,
        maxBufferedBytesPerClass: 2_048,
        heartbeatIntervalMs: 2_500,
        heartbeatTimeoutMs: 7_500,
      }),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      controlNegotiation: {
        supportedVersions: [
          { major: 2, minor: 0 },
          { major: 2, minor: 1 },
        ],
        supportedCapabilities: [RunnerCapability.OPERATIONS, RunnerCapability.EVENTS],
        resolveResumeCursors: async (_context, hello) => ({
          eventCursors: hello.eventCursors.slice(0, 1),
          terminalCursors: hello.terminalCursors.slice(0, 1),
        }),
      },
      sessionRegistry: new RunnerGrpcSessionRegistry({
        heartbeatTimeoutMs: 7_500,
        initialEpoch: 41n,
      }),
    });
    client = createClient(endpoint!.port);
    const stream = client.control(metadata('good-token'));
    const helloResponse = nextMessage(stream);

    stream.write({
      hello: runnerHello({
        supportedVersions: [
          { major: 2, minor: 0 },
          { major: 1, minor: 9 },
          { major: 2, minor: 1 },
        ],
        requestedLimits: {
          maxMessageBytes: 2_048,
          maxFrameBytes: 256,
          maxPendingOperations: 0,
          maxActiveTunnels: 2,
          maxActiveTerminals: 9,
          maxBufferedBytesPerClass: '1024',
        },
        eventCursors: [
          { executionId: 'execution-1', lastAcceptedSequence: '7' },
          { executionId: 'execution-2', lastAcceptedSequence: '11' },
        ],
        terminalCursors: [{ terminalId: 'terminal-1', lastSeenOutputSequence: '5' }],
      }),
    });

    expect(await helloResponse).toEqual({
      message: 'hello',
      hello: {
        selectedVersion: { major: 2, minor: 1 },
        sessionEpoch: '42',
        enabledCapabilities: ['RUNNER_CAPABILITY_OPERATIONS', 'RUNNER_CAPABILITY_EVENTS'],
        effectiveLimits: {
          maxMessageBytes: 1_024,
          maxFrameBytes: 256,
          maxPendingOperations: 8,
          maxActiveTunnels: 2,
          maxActiveTerminals: 4,
          maxBufferedBytesPerClass: '1024',
        },
        heartbeatInterval: { seconds: '2', nanos: 500_000_000 },
        heartbeatTimeout: { seconds: '7', nanos: 500_000_000 },
        acceptedEventCursors: [{ executionId: 'execution-1', lastAcceptedSequence: '7' }],
        acceptedTerminalCursors: [{ terminalId: 'terminal-1', lastSeenOutputSequence: '5' }],
      },
    });

    const heartbeatResponse = nextMessage(stream);
    stream.write({ heartbeat: { ordinal: '9' } });
    expect(await heartbeatResponse).toMatchObject({
      message: 'heartbeat',
      heartbeat: { acknowledgedOrdinal: '9' },
    });
    stream.end();
  });

  test('returns a typed supported range without activating an incompatible runner', async () => {
    let resolvedCursors = false;
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      controlNegotiation: {
        supportedVersions: [
          { major: 2, minor: 0 },
          { major: 2, minor: 2 },
        ],
        resolveResumeCursors: async () => {
          resolvedCursors = true;
          return { eventCursors: [], terminalCursors: [] };
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.control(metadata('good-token'));
    const response = nextMessage(stream);
    stream.write({
      hello: runnerHello({ supportedVersions: [{ major: 1, minor: 9 }] }),
    });

    expect(await response).toEqual({
      message: 'failure',
      failure: {
        code: 'FAILURE_CODE_UNSUPPORTED_PROTOCOL',
        message: 'runner protocol version is not supported',
        retryable: false,
        details: {
          fields: {
            minimumMajor: { kind: 'numberValue', numberValue: 2 },
            minimumMinor: { kind: 'numberValue', numberValue: 0 },
            maximumMajor: { kind: 'numberValue', numberValue: 2 },
            maximumMinor: { kind: 'numberValue', numberValue: 2 },
          },
        },
      },
    });
    expect(resolvedCursors).toBe(false);
  });

  test('rejects control traffic before RunnerHello', async () => {
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.control(metadata('good-token'));
    const response = nextMessage(stream);
    stream.write({ heartbeat: { ordinal: '1' } });

    expect(await response).toMatchObject({
      message: 'failure',
      failure: {
        code: 'FAILURE_CODE_INVALID_ARGUMENT',
        message: 'RunnerHello must be the first control message',
        retryable: false,
      },
    });
  });

  test('rejects a hello without a runner instance ID before allocating an epoch', async () => {
    const sessions = new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: 45_000,
    });
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
    });
    client = createClient(endpoint!.port);
    const stream = client.control(metadata('good-token'));
    const response = nextMessage(stream);
    stream.write({ hello: runnerHello({ runner: {} }) });

    expect(await response).toMatchObject({
      message: 'failure',
      failure: {
        code: 'FAILURE_CODE_INVALID_ARGUMENT',
        message: 'RunnerHello requires a runner instance ID',
      },
    });
    expect(sessions.activeEpoch('runner-1')).toBeNull();
  });

  test('supersedes the old control stream without stale offline cleanup', async () => {
    const unavailableEpochs: bigint[] = [];
    const sessions = new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: 45_000,
      onUnavailable: (_runnerId, epoch) => {
        unavailableEpochs.push(epoch);
      },
    });
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
    });
    client = createClient(endpoint!.port);

    const first = client.control(metadata('good-token'));
    const firstHello = nextMessage(first);
    first.write({ hello: runnerHello() });
    expect(await firstHello).toMatchObject({ hello: { sessionEpoch: '1' } });

    const displaced = nextMessage(first);
    const second = client.control(metadata('good-token'));
    const secondHello = nextMessage(second);
    second.write({
      hello: runnerHello({
        runner: {
          instanceId: 'instance-2',
          name: 'runner-1',
          hostname: 'runner.example',
          operatingSystem: 'linux',
        },
      }),
    });

    expect(await secondHello).toMatchObject({ hello: { sessionEpoch: '2' } });
    expect(await displaced).toMatchObject({
      failure: {
        code: 'FAILURE_CODE_UNAVAILABLE',
        message: 'runner session was superseded by a newer connection',
      },
    });
    await sessions.whenIdle('runner-1');
    expect(unavailableEpochs).toEqual([]);
    expect(sessions.activeEpoch('runner-1')).toBe(2n);

    second.cancel();
  });
});

describe('runner gRPC events stream', () => {
  test('resumes from the server cursor and returns cumulative receipts without reapplying duplicates', async () => {
    const receipts = new MemoryEventReceiptStore({ 'execution-1': 4n });
    const applied: bigint[] = [];
    const resynchronized: Array<{
      requestedSequence: bigint;
      earliestAvailableSequence: bigint;
    }> = [];
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      events: {
        receipts,
        applyEvent: async (_context, event) => {
          applied.push(event.sequence);
        },
        resynchronizeThread: async (_context, gap) => {
          resynchronized.push({
            requestedSequence: gap.requestedSequence,
            earliestAvailableSequence: gap.earliestAvailableSequence,
          });
        },
      },
    });
    client = createClient(endpoint!.port);

    const control = client.control(metadata('good-token'));
    const hello = nextMessage(control);
    control.write({
      hello: runnerHello({
        eventCursors: [{ executionId: 'execution-1', lastAcceptedSequence: '99' }],
      }),
    });
    expect(await hello).toMatchObject({
      hello: {
        sessionEpoch: '1',
        acceptedEventCursors: [{ executionId: 'execution-1', lastAcceptedSequence: '4' }],
      },
    });

    const events = client.events(metadata('good-token'));
    const event = (sequence: string) => ({
      session: { sessionEpoch: '1' },
      scope: { threadId: 'thread-1', executionId: 'execution-1' },
      sequence,
      event: {
        eventType: 'agent:chunk',
        data: { fields: { text: { stringValue: `chunk-${sequence}` } } },
        durability: 'EVENT_DURABILITY_DURABLE',
      },
    });

    const accepted = nextMessage(events);
    events.write(event('5'));
    expect(await accepted).toMatchObject({
      scope: { threadId: 'thread-1', executionId: 'execution-1' },
      accepted: { highestContiguousSequence: '5' },
    });

    const duplicate = nextMessage(events);
    events.write(event('5'));
    expect(await duplicate).toMatchObject({
      accepted: { highestContiguousSequence: '5' },
    });

    const outOfOrder = nextMessage(events);
    events.write(event('7'));
    expect(await outOfOrder).toMatchObject({
      gap: {
        requestedSequence: '7',
        earliestAvailableSequence: '6',
        reason: 'event sequence is not contiguous',
      },
    });
    expect(applied).toEqual([5n]);

    const recovered = nextMessage(events);
    events.write({
      session: { sessionEpoch: '1' },
      scope: { threadId: 'thread-1', executionId: 'execution-1' },
      sequence: '7',
      gap: {
        requestedSequence: '6',
        earliestAvailableSequence: '7',
        reason: 'chunk history expired',
      },
    });
    expect(await recovered).toMatchObject({
      gap: {
        requestedSequence: '6',
        earliestAvailableSequence: '7',
        reason: 'chunk history expired',
      },
    });

    const terminal = nextMessage(events);
    events.write({
      ...event('7'),
      event: {
        eventType: 'agent:result',
        data: { fields: { status: { stringValue: 'completed' } } },
        durability: 'EVENT_DURABILITY_TERMINAL',
      },
    });
    expect(await terminal).toMatchObject({
      accepted: { highestContiguousSequence: '7' },
    });
    expect(resynchronized).toEqual([{ requestedSequence: 6n, earliestAvailableSequence: 7n }]);
    expect(applied).toEqual([5n, 7n]);

    events.cancel();
    control.cancel();
  });
});

describe('runner gRPC operations stream', () => {
  function activeSessions(): RunnerGrpcSessionRegistry {
    const sessions = new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: 45_000,
    });
    sessions.activate('runner-1', { invalidate: () => undefined });
    return sessions;
  }

  test('dispatches an allowlisted typed read with credential-derived identity', async () => {
    const sessions = activeSessions();
    const observed = Promise.withResolvers<{
      runnerId: string;
      userId: string | null;
      request: Record<string, unknown>;
    }>();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        execute: async (context, operation) => {
          observed.resolve({
            runnerId: context.principal.runnerId,
            userId: context.principal.userId,
            request: operation.request,
          });
          return {
            type: 'data:get_thread_response',
            thread: { id: 'thread-1' },
          };
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const response = nextMessage(stream);
    stream.write(operationRequest({ getThread: { threadId: 'thread-1' } }));

    expect(await observed.promise).toEqual({
      runnerId: 'runner-1',
      userId: 'user-1',
      request: { type: 'data:get_thread', threadId: 'thread-1' },
    });
    expect(await response).toMatchObject({
      session: { sessionEpoch: '1' },
      correlationId: 'operation-1',
      outcome: 'success',
      success: { result: 'thread' },
    });
    stream.cancel();
  });

  test('accepts nanoid correlation IDs beginning with URL-safe punctuation', async () => {
    const sessions = activeSessions();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        execute: async () => ({
          type: 'data:get_thread_response',
          thread: { id: 'thread-1' },
        }),
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token'));

    for (const correlationId of ['-nanoid-style', '_nanoid-style']) {
      const response = nextMessage(stream);
      stream.write(
        operationRequest(
          { getThread: { threadId: 'thread-1' } },
          {
            metadata: {
              correlationId,
              deadline: operationDeadline(),
            },
          },
        ),
      );
      expect(await response).toMatchObject({
        correlationId,
        outcome: 'success',
      });
    }
    stream.cancel();
  });

  test('maps v2 message image JSON back to the legacy repository payload', async () => {
    const sessions = activeSessions();
    const observed = Promise.withResolvers<Record<string, unknown>>();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        idempotency: {
          execute: async (_input, execute) => ({
            kind: 'executed',
            outcome: await execute(),
          }),
          cleanupExpired: async () => 0,
        },
        execute: async (_context, operation) => {
          observed.resolve(operation.request);
          return { messageId: 'message-1' };
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token'));
    const response = nextMessage(stream);
    stream.write(
      operationRequest(
        {
          insertMessage: {
            threadId: 'thread-1',
            role: 'user',
            content: 'hello',
            imagesJson: '[]',
          },
        },
        {
          metadata: {
            correlationId: 'insert-message',
            deadline: operationDeadline(),
            idempotencyKey: 'insert-message-key',
          },
        },
      ),
    );

    expect(await observed.promise).toMatchObject({
      type: 'data:insert_message',
      threadId: 'thread-1',
      payload: {
        threadId: 'thread-1',
        role: 'user',
        content: 'hello',
        images: '[]',
      },
    });
    expect(await response).toMatchObject({
      correlationId: 'insert-message',
      success: { insertedRecord: { id: 'message-1' } },
    });
    stream.cancel();
  });

  test('rejects stale sessions, missing deadlines, and operations outside the allowlist', async () => {
    const sessions = activeSessions();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;

    const stale = nextMessage(stream);
    stream.write(
      operationRequest(
        { getThread: { threadId: 'thread-1' } },
        { session: { sessionEpoch: '99' } },
      ),
    );
    expect(await stale).toMatchObject({
      failure: { code: 'FAILURE_CODE_UNAVAILABLE' },
    });

    const noDeadline = nextMessage(stream);
    stream.write(
      operationRequest(
        { getThread: { threadId: 'thread-1' } },
        { metadata: { correlationId: 'no-deadline' } },
      ),
    );
    expect(await noDeadline).toMatchObject({
      failure: {
        code: 'FAILURE_CODE_INVALID_ARGUMENT',
        message: 'an operation deadline is required',
      },
    });

    const disallowed = nextMessage(stream);
    stream.write(
      operationRequest(
        {},
        {
          metadata: {
            correlationId: 'disallowed',
            deadline: operationDeadline(),
          },
        },
      ),
    );
    expect(await disallowed).toMatchObject({
      failure: {
        code: 'FAILURE_CODE_INVALID_ARGUMENT',
        message: 'operation is not allowed',
      },
    });
    stream.cancel();
  });

  test('returns typed authorization failures without exposing resource details', async () => {
    const sessions = activeSessions();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        idempotency: {
          execute: async (_input, execute) => ({
            kind: 'executed',
            outcome: await execute(),
          }),
          cleanupExpired: async () => 0,
        },
        execute: async () => ({
          type: 'data:ack',
          success: false,
          error: 'Forbidden',
        }),
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const response = nextMessage(stream);
    stream.write(
      operationRequest(
        { updateMessage: { messageId: 'foreign-message', content: 'x' } },
        {
          metadata: {
            correlationId: 'operation-1',
            deadline: operationDeadline(),
            idempotencyKey: 'update-foreign-message-1',
          },
        },
      ),
    );

    expect(await response).toMatchObject({
      correlationId: 'operation-1',
      failure: {
        code: 'FAILURE_CODE_PERMISSION_DENIED',
        message: 'operation is not authorized',
        retryable: false,
      },
    });
    stream.cancel();
  });

  test('requires mutation keys and replays committed outcomes without duplicate execution', async () => {
    const connection = createSqliteDatabase({
      mode: 'sqlite',
      path: ':memory:',
    });
    connection.sqlite!.exec(`
      CREATE TABLE runner_operation_idempotency (
        runner_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (runner_id, operation_kind, idempotency_key)
      )
    `);
    const idempotency = new SqlOperationIdempotencyStore({
      retentionMs: 60_000,
      database: connection.db,
      transaction: async (work) => work(),
    });
    const mutation = { messageId: 'message-1', content: 'committed' };
    let executions = 0;
    await idempotency.execute(
      {
        runnerId: 'runner-1',
        operationKind: 'updateMessage',
        idempotencyKey: 'mutation-1',
        request: mutation,
      },
      async () => {
        executions += 1;
        return { type: 'data:ack', success: true };
      },
    );

    const sessions = activeSessions();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        idempotency,
        execute: async () => {
          executions += 1;
          return { type: 'data:ack', success: true };
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;

    const missingKey = nextMessage(stream);
    stream.write(operationRequest({ updateMessage: mutation }));
    expect(await missingKey).toMatchObject({
      failure: {
        code: 'FAILURE_CODE_INVALID_ARGUMENT',
        message: 'a valid idempotency key is required for persistent mutations',
      },
    });

    const replay = nextMessage(stream);
    stream.write(
      operationRequest(
        { updateMessage: mutation },
        {
          metadata: {
            correlationId: 'replay',
            deadline: operationDeadline(),
            idempotencyKey: 'mutation-1',
          },
        },
      ),
    );
    expect(await replay).toMatchObject({
      correlationId: 'replay',
      outcome: 'success',
    });
    expect(executions).toBe(1);

    const conflict = nextMessage(stream);
    stream.write(
      operationRequest(
        { updateMessage: { ...mutation, content: 'different' } },
        {
          metadata: {
            correlationId: 'conflict',
            deadline: operationDeadline(),
            idempotencyKey: 'mutation-1',
          },
        },
      ),
    );
    expect(await conflict).toMatchObject({
      correlationId: 'conflict',
      failure: { code: 'FAILURE_CODE_CONFLICT', retryable: false },
    });
    expect(executions).toBe(1);

    const nanoidKey = nextMessage(stream);
    stream.write(
      operationRequest(
        { updateMessage: mutation },
        {
          metadata: {
            correlationId: 'nanoid-key',
            deadline: operationDeadline(),
            idempotencyKey: '_nanoid-style-key',
          },
        },
      ),
    );
    expect(await nanoidKey).toMatchObject({
      correlationId: 'nanoid-key',
      outcome: 'success',
    });
    expect(executions).toBe(2);

    stream.cancel();
    connection.close();
  });

  test('enforces operation concurrency and propagates stream cancellation', async () => {
    const sessions = activeSessions();
    const firstStarted = Promise.withResolvers<AbortSignal>();
    const firstCancelled = Promise.withResolvers<void>();
    endpoint = await startRunnerGrpcEndpoint({
      config: config({ maxPendingOperations: 1 }),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        execute: async (_context, operation) => {
          firstStarted.resolve(operation.signal);
          operation.signal.addEventListener('abort', () => firstCancelled.resolve(), {
            once: true,
          });
          return new Promise(() => undefined);
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    stream.write(operationRequest({ getThread: { threadId: 'thread-1' } }));
    const signal = await firstStarted.promise;

    const limited = nextMessage(stream);
    stream.write(
      operationRequest(
        { getThread: { threadId: 'thread-2' } },
        {
          metadata: {
            correlationId: 'operation-2',
            deadline: operationDeadline(),
          },
        },
      ),
    );
    expect(await limited).toMatchObject({
      correlationId: 'operation-2',
      failure: { code: 'FAILURE_CODE_RESOURCE_EXHAUSTED' },
    });

    const status = statusOf(stream);
    stream.cancel();
    await status;
    await firstCancelled.promise;
    expect(signal.aborted).toBe(true);
  });

  test('returns DEADLINE_EXCEEDED and aborts work at the declared deadline', async () => {
    const sessions = activeSessions();
    const aborted = Promise.withResolvers<void>();
    endpoint = await startRunnerGrpcEndpoint({
      config: config(),
      dependencies: {
        authenticateRunner: async () => 'runner-1',
        getRunnerUserId: async () => 'user-1',
      },
      sessionRegistry: sessions,
      operations: {
        execute: async (_context, operation) => {
          operation.signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          return new Promise(() => undefined);
        },
      },
    });
    client = createClient(endpoint!.port);
    const stream = client.operations(metadata('good-token')) as grpc.ClientDuplexStream<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const response = nextMessage(stream);
    stream.write(
      operationRequest(
        { getThread: { threadId: 'thread-1' } },
        {
          metadata: {
            correlationId: 'deadline',
            deadline: operationDeadline(30),
          },
        },
      ),
    );

    await aborted.promise;
    expect(await response).toMatchObject({
      correlationId: 'deadline',
      failure: { code: 'FAILURE_CODE_DEADLINE_EXCEEDED' },
    });
    stream.cancel();
  });
});
