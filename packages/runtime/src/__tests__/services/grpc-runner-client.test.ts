import { EventEmitter } from 'node:events';

import { RUNNER_GRPC_MAX_MESSAGE_BYTES } from '@funny/shared/runner-protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  runnerGrpcChannelOptions,
  RunnerGrpcClient,
  type RunnerGrpcDuplexStream,
  type RunnerGrpcTransport,
  type RunnerGrpcWireMessage,
} from '../../services/grpc-runner-client.js';

class FakeStream extends EventEmitter implements RunnerGrpcDuplexStream {
  readonly writes: RunnerGrpcWireMessage[] = [];
  ended = false;
  cancelled = false;

  write(message: RunnerGrpcWireMessage): boolean {
    this.writes.push(message);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

class FakeTransport implements RunnerGrpcTransport {
  readonly streams = new Map<string, FakeStream>();
  readonly opened: string[] = [];
  closed = false;

  open(name: 'control' | 'operations' | 'events' | 'tunnel' | 'terminal'): FakeStream {
    const stream = new FakeStream();
    this.opened.push(name);
    this.streams.set(name, stream);
    return stream;
  }

  close(): void {
    this.closed = true;
  }
}

function createClient(
  transportFactory: (endpoint: string, token: string) => RunnerGrpcTransport,
  overrides: Partial<ConstructorParameters<typeof RunnerGrpcClient>[0]> = {},
) {
  return new RunnerGrpcClient({
    endpoint: 'grpc.example.test:50051',
    token: 'runner-secret',
    runner: {
      instanceId: 'runner-1',
      name: 'test runner',
      hostname: 'runner-host',
      operatingSystem: 'linux',
      activeProviderIds: ['codex'],
    },
    transportFactory,
    ...overrides,
  });
}

describe('RunnerGrpcClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('allows operation payloads up to the shared 32 MiB transport ceiling', () => {
    expect(runnerGrpcChannelOptions()).toMatchObject({
      'grpc.max_receive_message_length': RUNNER_GRPC_MAX_MESSAGE_BYTES,
      'grpc.max_send_message_length': RUNNER_GRPC_MAX_MESSAGE_BYTES,
    });
  });

  test('authenticates the channel and opens data streams only after ServerHello', () => {
    const transport = new FakeTransport();
    const factory = vi.fn(() => transport);
    const activated = vi.fn();
    const client = createClient(factory, {
      eventCursors: [{ executionId: 'execution-1', lastAcceptedSequence: 7n }],
      terminalCursors: [{ terminalId: 'terminal-1', lastSeenOutputSequence: 4n }],
      onActivated: activated,
    });

    client.start();

    expect(factory).toHaveBeenCalledWith('grpc.example.test:50051', 'runner-secret');
    expect(transport.opened).toEqual(['control']);
    expect(client.isActive()).toBe(false);
    expect(transport.streams.get('control')?.writes[0]).toMatchObject({
      hello: {
        supportedVersions: [{ major: 2, minor: 0 }],
        runner: {
          instanceId: 'runner-1',
          activeProviderIds: ['codex'],
        },
        capabilities: [1, 2, 3, 4],
        eventCursors: [{ executionId: 'execution-1', lastAcceptedSequence: '7' }],
        terminalCursors: [{ terminalId: 'terminal-1', lastSeenOutputSequence: '4' }],
      },
    });

    transport.streams.get('control')?.emit('data', {
      hello: {
        sessionEpoch: '23',
        heartbeatInterval: { seconds: '2' },
      },
    });

    expect(client.isActive()).toBe(true);
    expect(client.sessionEpoch()).toBe('23');
    expect(transport.opened).toEqual(['control', 'operations', 'events', 'tunnel', 'terminal']);
    expect(transport.streams.get('tunnel')?.writes).toEqual([
      { session: { sessionEpoch: '23' }, ready: {} },
    ]);
    expect(transport.streams.get('terminal')?.writes).toEqual([
      { session: { sessionEpoch: '23' }, ready: {} },
    ]);
    expect(activated).toHaveBeenCalledWith(expect.objectContaining({ sessionEpoch: '23' }));
    expect(transport.streams.get('control')?.writes[1]).toMatchObject({
      heartbeat: { ordinal: '1' },
    });

    expect(client.send('events', { event: { sequence: '8' } })).toBe(true);
    expect(transport.streams.get('events')?.writes).toEqual([
      { session: { sessionEpoch: '23' }, event: { sequence: '8' } },
    ]);

    vi.advanceTimersByTime(2_000);
    expect(transport.streams.get('control')?.writes[2]).toMatchObject({
      heartbeat: { ordinal: '2' },
    });

    client.shutdown();
  });

  test('reconnects with backoff after a stream failure and ignores stale cleanup', () => {
    const transports = [new FakeTransport(), new FakeTransport()];
    const factory = vi.fn(() => transports[factory.mock.calls.length - 1]!);
    const disconnected = vi.fn();
    const client = createClient(factory, {
      reconnectMinimumMs: 100,
      reconnectMaximumMs: 1_000,
      onDisconnected: disconnected,
    });

    client.start();
    const firstControl = transports[0]!.streams.get('control')!;
    firstControl.emit('data', { hello: { sessionEpoch: '1' } });
    transports[0]!.streams.get('events')!.emit('error', new Error('network lost'));

    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ message: 'network lost' }));
    expect(transports[0]!.closed).toBe(true);
    expect(client.isActive()).toBe(false);

    vi.advanceTimersByTime(99);
    expect(factory).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(transports[1]!.opened).toEqual(['control']);

    firstControl.emit('close');
    vi.advanceTimersByTime(1_000);
    expect(factory).toHaveBeenCalledTimes(2);

    client.shutdown();
  });

  test('does not reconnect after a non-retryable control failure', () => {
    const transport = new FakeTransport();
    const factory = vi.fn(() => transport);
    const disconnected = vi.fn();
    const client = createClient(factory, {
      reconnectMinimumMs: 100,
      onDisconnected: disconnected,
    });

    client.start();
    const control = transport.streams.get('control')!;
    control.emit('data', { hello: { sessionEpoch: '17' } });
    control.emit('data', {
      failure: {
        code: 14,
        message: 'runner session was superseded by a newer connection',
        retryable: false,
      },
    });

    expect(disconnected).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'runner session was superseded by a newer connection' }),
    );
    expect(client.isActive()).toBe(false);
    expect(transport.closed).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('sends a closing frame and releases every stream during graceful shutdown', () => {
    const transport = new FakeTransport();
    const client = createClient(() => transport);

    client.start();
    const control = transport.streams.get('control')!;
    control.emit('data', { hello: { sessionEpoch: '9' } });
    const dataStreams = [...transport.streams.entries()].filter(([name]) => name !== 'control');

    client.shutdown('process stopping');

    expect(control.writes.at(-1)).toEqual({ closing: { reason: 'process stopping' } });
    expect(control.ended).toBe(true);
    expect(dataStreams.every(([, stream]) => stream.cancelled)).toBe(true);
    expect(transport.closed).toBe(true);
    expect(client.isActive()).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(transport.opened.filter((name) => name === 'control')).toHaveLength(1);
  });
});
