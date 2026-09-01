import {
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type DescMessage,
  type DescMethodStreaming,
} from '@bufbuild/protobuf';
import { RUNNER_GRPC_MAX_MESSAGE_BYTES } from '@funny/shared/runner-protocol';
import { RunnerCapability } from '@funny/shared/runner-v2/common';
import { RunnerTransportService } from '@funny/shared/runner-v2/control';
import * as grpc from '@grpc/grpc-js';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { metric, recordHistogram } from '../lib/telemetry.js';

export type RunnerGrpcStreamName = 'operations' | 'events' | 'tunnel' | 'terminal';
export type RunnerGrpcWireMessage = Record<string, any>;

export interface RunnerGrpcDuplexStream {
  write(message: RunnerGrpcWireMessage): boolean;
  end(): void;
  cancel(): void;
  on(event: 'data', listener: (message: RunnerGrpcWireMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close' | 'end', listener: () => void): this;
}

export interface RunnerGrpcTransport {
  open(name: 'control' | RunnerGrpcStreamName): RunnerGrpcDuplexStream;
  close(): void;
}

export interface RunnerGrpcClientOptions {
  endpoint: string;
  token: string;
  runner: {
    instanceId: string;
    name: string;
    hostname: string;
    operatingSystem: string;
    workspace?: string;
    activeProviderIds?: string[];
  };
  eventCursors?: Array<{ executionId: string; lastAcceptedSequence: bigint }>;
  terminalCursors?: Array<{ terminalId: string; lastSeenOutputSequence: bigint }>;
  reconnectMinimumMs?: number;
  reconnectMaximumMs?: number;
  transportFactory?: (endpoint: string, token: string) => RunnerGrpcTransport;
  onActivated?: (hello: RunnerGrpcWireMessage) => void;
  onDisconnected?: (error?: Error) => void;
  onControl?: (message: RunnerGrpcWireMessage) => void;
  onStreamMessage?: (name: RunnerGrpcStreamName, message: RunnerGrpcWireMessage) => void;
}

function normalizeEndpoint(raw: string): { address: string; secure: boolean } {
  const value = raw.trim();
  if (!value) throw new Error('runner gRPC endpoint is required');
  if (!value.includes('://')) return { address: value, secure: false };
  const url = new URL(value);
  if (!url.port) throw new Error('runner gRPC endpoint must include a port');
  return { address: `${url.hostname}:${url.port}`, secure: url.protocol === 'https:' };
}

function grpcMethodDefinition(
  method: DescMethodStreaming,
): grpc.MethodDefinition<RunnerGrpcWireMessage, RunnerGrpcWireMessage> {
  const encode = (schema: DescMessage, value: RunnerGrpcWireMessage): Buffer =>
    Buffer.from(toBinary(schema, fromJson(schema, value)));
  const decode = (schema: DescMessage, value: Buffer): RunnerGrpcWireMessage =>
    toJson(schema, fromBinary(schema, value), { enumAsInteger: true }) as RunnerGrpcWireMessage;
  return {
    path: `/${RunnerTransportService.typeName}/${method.name}`,
    requestStream: true,
    responseStream: true,
    requestSerialize: (value) => encode(method.input, value),
    requestDeserialize: (value) => decode(method.input, value),
    responseSerialize: (value) => encode(method.output, value),
    responseDeserialize: (value) => decode(method.output, value),
  };
}

const runnerTransportDefinition = Object.fromEntries(
  RunnerTransportService.methods.map((method) => [
    method.localName,
    grpcMethodDefinition(method as DescMethodStreaming),
  ]),
) as grpc.ServiceDefinition;

export function runnerGrpcChannelOptions(): grpc.ChannelOptions {
  return {
    'grpc.keepalive_time_ms': 15_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_receive_message_length': RUNNER_GRPC_MAX_MESSAGE_BYTES,
    'grpc.max_send_message_length': RUNNER_GRPC_MAX_MESSAGE_BYTES,
  };
}

function createGrpcTransport(endpoint: string, token: string): RunnerGrpcTransport {
  const service = grpc.makeGenericClientConstructor(
    runnerTransportDefinition,
    RunnerTransportService.name,
  );
  const { address, secure } = normalizeEndpoint(endpoint);
  const client = new service(
    address,
    secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    runnerGrpcChannelOptions(),
  ) as grpc.Client & Record<string, (metadata: grpc.Metadata) => RunnerGrpcDuplexStream>;
  const metadata = new grpc.Metadata();
  metadata.set('authorization', `Bearer ${token}`);
  return {
    open(name) {
      const method = client[name];
      if (typeof method !== 'function')
        throw new Error(`runner gRPC method ${name} is unavailable`);
      const callMetadata = metadata.clone();
      callMetadata.set('x-correlation-id', nanoid());
      return method.call(client, callMetadata);
    },
    close: () => client.close(),
  };
}

function durationMilliseconds(value: unknown, fallback: number): number {
  if (typeof value === 'string') {
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))s$/.exec(value);
    if (match) {
      const milliseconds = Number(match[1]) * 1_000;
      if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
    }
    return fallback;
  }
  const duration = value as { seconds?: string | number; nanos?: number } | undefined;
  if (!duration) return fallback;
  const milliseconds = Number(duration.seconds ?? 0) * 1_000 + Number(duration.nanos ?? 0) / 1e6;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallback;
}

/**
 * Owns one negotiated runner v2 session. A generation guard prevents stale
 * stream cleanup from reconnecting or publishing after a replacement session.
 */
export class RunnerGrpcClient {
  private transport: RunnerGrpcTransport | null = null;
  private control: RunnerGrpcDuplexStream | null = null;
  private readonly streams = new Map<RunnerGrpcStreamName, RunnerGrpcDuplexStream>();
  private epoch: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private connectStartedAt = 0;
  private heartbeatOrdinal = 0n;
  private stopped = true;

  constructor(private readonly options: RunnerGrpcClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  isActive(): boolean {
    return !this.stopped && this.epoch !== null;
  }

  sessionEpoch(): string | null {
    return this.epoch;
  }

  send(name: RunnerGrpcStreamName, message: RunnerGrpcWireMessage): boolean {
    const stream = this.streams.get(name);
    if (!stream || !this.epoch) return false;
    return stream.write({ session: { sessionEpoch: this.epoch }, ...message });
  }

  sendControl(message: RunnerGrpcWireMessage): boolean {
    if (!this.control || !this.epoch) return false;
    return this.control.write(message);
  }

  shutdown(reason = 'runner shutdown'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.control && this.epoch) this.control.write({ closing: { reason } });
    this.closeTransport();
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.connectStartedAt = Date.now();
    this.closeTransport();
    try {
      this.transport = (this.options.transportFactory ?? createGrpcTransport)(
        this.options.endpoint,
        this.options.token,
      );
      const control = this.transport.open('control');
      this.control = control;
      control.on('data', (message) => this.receiveControl(generation, message));
      control.on('error', (error) => this.disconnect(generation, error));
      control.on('close', () => this.disconnect(generation));
      control.on('end', () => this.disconnect(generation));
      control.write({
        hello: {
          supportedVersions: [{ major: 2, minor: 0 }],
          runner: {
            ...this.options.runner,
            activeProviderIds: this.options.runner.activeProviderIds ?? [],
          },
          capabilities: [
            RunnerCapability.OPERATIONS,
            RunnerCapability.EVENTS,
            RunnerCapability.HTTP_TUNNEL,
            RunnerCapability.TERMINAL,
          ],
          requestedLimits: {},
          eventCursors: (this.options.eventCursors ?? []).map((cursor) => ({
            ...cursor,
            lastAcceptedSequence: String(cursor.lastAcceptedSequence),
          })),
          terminalCursors: (this.options.terminalCursors ?? []).map((cursor) => ({
            ...cursor,
            lastSeenOutputSequence: String(cursor.lastSeenOutputSequence),
          })),
        },
      });
    } catch (error) {
      this.disconnect(generation, error as Error);
    }
  }

  private receiveControl(generation: number, message: RunnerGrpcWireMessage): void {
    if (generation !== this.generation || this.stopped) return;
    if (message.failure) {
      this.disconnect(
        generation,
        new Error(message.failure.message || 'gRPC negotiation failed'),
        message.failure.retryable === true,
      );
      return;
    }
    if (message.hello) {
      const epoch = String(message.hello.sessionEpoch ?? '');
      if (!epoch) {
        this.disconnect(generation, new Error('gRPC ServerHello omitted session epoch'));
        return;
      }
      this.epoch = epoch;
      this.reconnectAttempt = 0;
      const protocol = message.hello.selectedVersion
        ? `runner.v${String(message.hello.selectedVersion.major ?? 0)}.${String(message.hello.selectedVersion.minor ?? 0)}`
        : 'runner.v2';
      const attributes = { protocolVersion: protocol, status: 'active' };
      metric('runner.grpc.connection.events', 1, { attributes });
      recordHistogram('runner.grpc.connection.latency', Date.now() - this.connectStartedAt, {
        unit: 'ms',
        attributes,
      });
      log.info('Runner gRPC session activated', {
        namespace: 'runner-grpc',
        protocolVersion: protocol,
        sessionEpoch: epoch,
        latencyMs: Date.now() - this.connectStartedAt,
      });
      this.openDataStreams(generation);
      this.startHeartbeat(
        generation,
        durationMilliseconds(message.hello.heartbeatInterval, 15_000),
      );
      this.options.onActivated?.(message.hello);
      return;
    }
    this.options.onControl?.(message);
  }

  private openDataStreams(generation: number): void {
    if (!this.transport || !this.epoch) return;
    for (const name of ['operations', 'events', 'tunnel', 'terminal'] as const) {
      const stream = this.transport.open(name);
      this.streams.set(name, stream);
      stream.on('data', (message) => {
        if (generation === this.generation) this.options.onStreamMessage?.(name, message);
      });
      stream.on('error', (error) => this.disconnect(generation, error));
      stream.on('close', () => this.disconnect(generation));
      stream.on('end', () => this.disconnect(generation));
    }
    this.streams.get('tunnel')?.write({
      session: { sessionEpoch: this.epoch },
      ready: {},
    });
    this.streams.get('terminal')?.write({
      session: { sessionEpoch: this.epoch },
      ready: {},
    });
  }

  private startHeartbeat(generation: number, intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const send = () => {
      if (generation !== this.generation || !this.control || !this.epoch) return;
      this.control.write({
        heartbeat: {
          ordinal: String(++this.heartbeatOrdinal),
          // Protobuf JSON represents Timestamp as RFC 3339, not as its
          // seconds/nanos object form.
          sentAt: new Date().toISOString(),
          activeThreadIds: [],
        },
      });
    };
    this.heartbeatTimer = setInterval(send, intervalMs);
    this.heartbeatTimer.unref?.();
    send();
  }

  private disconnect(generation: number, error?: Error, retryable = true): void {
    if (generation !== this.generation || this.stopped) return;
    this.generation++;
    if (!retryable) this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.closeTransport();
    this.options.onDisconnected?.(error);
    // The owner may deliberately stop the client from its disconnection hook,
    // and protocol failures marked non-retryable (including session
    // replacement) must yield instead of fighting the winning runner forever.
    if (this.stopped) return;
    const minimum = this.options.reconnectMinimumMs ?? 1_000;
    const maximum = this.options.reconnectMaximumMs ?? 30_000;
    const delay = Math.min(maximum, minimum * 2 ** Math.min(this.reconnectAttempt++, 10));
    metric('runner.grpc.reconnects', 1, {
      attributes: {
        protocolVersion: 'runner.v2',
        status: 'scheduled',
        reason: error?.name ?? 'stream-closed',
      },
    });
    log.warn('Runner gRPC session disconnected; reconnect scheduled', {
      namespace: 'runner-grpc',
      protocolVersion: 'runner.v2',
      sessionEpoch: this.epoch,
      delayMs: delay,
      reconnectReason: error?.name ?? 'stream-closed',
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private closeTransport(): void {
    for (const stream of this.streams.values()) {
      try {
        stream.cancel();
      } catch {}
    }
    this.streams.clear();
    if (this.control) {
      try {
        this.control.end();
      } catch {}
    }
    this.control = null;
    this.transport?.close();
    this.transport = null;
    this.epoch = null;
  }
}
