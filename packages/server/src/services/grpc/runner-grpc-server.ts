import { resolve } from 'node:path';

import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { nanoid } from 'nanoid';

import { log } from '../../lib/logger.js';
import { relayToUser } from '../browser-events.js';
import type { RunnerPresencePort, RunnerRequestPort, RunnerTerminalPort } from '../runner-ports.js';
import type { RunnerGrpcConfig } from './config.js';
import { resolveRunnerGrpcConfig } from './config.js';
import {
  createControlNegotiationHandler,
  type ControlNegotiationOptions,
} from './control-negotiation.js';
import { SqlEventReceiptStore, type EventReceiptStore } from './event-receipts.js';
import { createEventsHandler, type EventsHandlerOptions } from './events-handler.js';
import { createOperationsHandler, type OperationsHandlerOptions } from './operations-handler.js';
import { GrpcRunnerRequestAdapter } from './runner-request-adapter.js';
import { RunnerGrpcSessionRegistry } from './session-registry.js';
import {
  createTerminalHandler,
  RunnerGrpcTerminalDispatcher,
  type TerminalHandlerOptions,
} from './terminal-handler.js';
import { observeRunnerGrpc } from './transport-observability.js';
import {
  createTunnelHandler,
  RunnerGrpcTunnelDispatcher,
  type TunnelHandlerOptions,
} from './tunnel-handler.js';

type StreamMessage = Record<string, unknown>;
export type RunnerGrpcCall = grpc.ServerDuplexStream<StreamMessage, StreamMessage>;

export interface RunnerGrpcPrincipal {
  runnerId: string;
  userId: string | null;
  tenantId: string | null;
}

export interface RunnerGrpcCallContext {
  correlationId: string;
  method: string;
  principal: RunnerGrpcPrincipal;
}

export type RunnerGrpcHandler = (
  call: RunnerGrpcCall,
  context: RunnerGrpcCallContext,
) => void | Promise<void>;

export interface RunnerGrpcDependencies {
  authenticateRunner(token: string): Promise<string | null>;
  getRunnerUserId(runnerId: string): Promise<string | null>;
  markRunnerOnline?(runnerId: string): Promise<void>;
  markRunnerOffline?(runnerId: string): Promise<void>;
}

export type RunnerGrpcHandlers = Record<
  'control' | 'operations' | 'events' | 'tunnel' | 'terminal',
  RunnerGrpcHandler
>;

export interface RunnerGrpcEndpoint {
  host: string;
  port: number;
  requests: RunnerRequestPort;
  terminals: RunnerTerminalPort;
  presence: RunnerPresencePort;
  shutdown(graceMs?: number): Promise<void>;
}

export interface RunnerGrpcEndpointOptions {
  config?: RunnerGrpcConfig;
  dependencies?: RunnerGrpcDependencies;
  handlers?: Partial<RunnerGrpcHandlers>;
  controlNegotiation?: ControlNegotiationOptions;
  operations?: OperationsHandlerOptions;
  events?: EventsHandlerOptions;
  tunnel?: TunnelHandlerOptions;
  terminal?: TerminalHandlerOptions;
  sessionRegistry?: RunnerGrpcSessionRegistry;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHORIZATION_SCHEME = 'Bearer ';

function serviceError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() });
}

function fail(call: RunnerGrpcCall, code: grpc.status, details: string): void {
  call.emit('error', serviceError(code, details));
}

function correlationIdFrom(metadata: grpc.Metadata): string {
  const supplied = metadata.get('x-correlation-id')[0];
  if (typeof supplied === 'string' && CORRELATION_ID_PATTERN.test(supplied)) return supplied;
  return nanoid();
}

function bearerTokenFrom(metadata: grpc.Metadata): string | null {
  const authorization = metadata.get('authorization')[0];
  if (typeof authorization !== 'string' || !authorization.startsWith(AUTHORIZATION_SCHEME)) {
    return null;
  }
  const token = authorization.slice(AUTHORIZATION_SCHEME.length);
  return token.length > 0 ? token : null;
}

class RunnerStreamLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maximum: number) {}

  acquire(runnerId: string): (() => void) | null {
    const count = this.active.get(runnerId) ?? 0;
    if (count >= this.maximum) return null;
    this.active.set(runnerId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(runnerId) ?? 1) - 1;
      if (remaining <= 0) this.active.delete(runnerId);
      else this.active.set(runnerId, remaining);
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(serviceError(grpc.status.DEADLINE_EXCEEDED, 'authentication timed out')),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Typed transport-boundary interceptor. It authenticates metadata, derives the
 * non-payload principal, applies a per-runner stream quota, and emits only safe
 * identifiers to logs.
 */
export function createRunnerGrpcInterceptor(
  method: string,
  handler: RunnerGrpcHandler,
  dependencies: RunnerGrpcDependencies,
  config: RunnerGrpcConfig,
  limiter: RunnerStreamLimiter = new RunnerStreamLimiter(config.maxConcurrentStreamsPerRunner),
): grpc.handleBidiStreamingCall<StreamMessage, StreamMessage> {
  return async (call) => {
    const openedAt = Date.now();
    const correlationId = correlationIdFrom(call.metadata);
    const token = bearerTokenFrom(call.metadata);
    if (!token) {
      log.warn('Rejected unauthenticated runner gRPC stream', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        status: 'UNAUTHENTICATED',
      });
      fail(call, grpc.status.UNAUTHENTICATED, 'runner credentials required');
      return;
    }

    let runnerId: string | null;
    try {
      runnerId = await withTimeout(dependencies.authenticateRunner(token), config.authTimeoutMs);
    } catch (error) {
      const status = (error as Partial<grpc.ServiceError>).code ?? grpc.status.INTERNAL;
      log.warn('Runner gRPC authentication failed', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        status: grpc.status[status],
      });
      fail(
        call,
        status,
        status === grpc.status.DEADLINE_EXCEEDED
          ? 'authentication timed out'
          : 'authentication failed',
      );
      return;
    }
    if (!runnerId) {
      log.warn('Rejected invalid runner gRPC credentials', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        status: 'UNAUTHENTICATED',
      });
      fail(call, grpc.status.UNAUTHENTICATED, 'invalid runner credentials');
      return;
    }

    const release = limiter.acquire(runnerId);
    if (!release) {
      log.warn('Rejected runner gRPC stream above per-runner limit', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        runnerId,
        status: 'RESOURCE_EXHAUSTED',
      });
      fail(call, grpc.status.RESOURCE_EXHAUSTED, 'runner stream limit exceeded');
      return;
    }

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    call.once('cancelled', releaseOnce);
    call.once('close', releaseOnce);
    call.once('error', releaseOnce);
    call.once('finish', releaseOnce);

    try {
      const userId = await dependencies.getRunnerUserId(runnerId);
      const context: RunnerGrpcCallContext = {
        correlationId,
        method,
        principal: { runnerId, userId, tenantId: userId },
      };
      log.info('Accepted runner gRPC stream', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        runnerId,
      });
      observeRunnerGrpc({
        event: 'stream-opened',
        streamClass: method as RunnerGrpcObservationStream,
        status: 'ok',
        runnerId,
        correlationId,
      });
      let observedClose = false;
      const observeClose = () => {
        if (observedClose) return;
        observedClose = true;
        observeRunnerGrpc({
          event: 'stream-closed',
          streamClass: method as RunnerGrpcObservationStream,
          status: 'ok',
          runnerId,
          correlationId,
          latencyMs: Date.now() - openedAt,
        });
      };
      call.once('cancelled', observeClose);
      call.once('close', observeClose);
      call.once('error', observeClose);
      call.once('finish', observeClose);
      await handler(call, context);
    } catch (error) {
      log.error('Runner gRPC stream handler failed', {
        namespace: 'runner-grpc',
        correlationId,
        method,
        runnerId,
        errorType: error instanceof Error ? error.name : 'unknown',
        status: 'INTERNAL',
      });
      fail(call, grpc.status.INTERNAL, 'runner stream failed');
    }
  };
}

type RunnerGrpcObservationStream = 'control' | 'operations' | 'events' | 'tunnel' | 'terminal';

function locateProtocol(): string {
  const sourcePath = resolve(import.meta.dir, '..', '..', '..', '..', '..', 'protocol');
  const bundledPath = resolve(import.meta.dir, 'protocol');
  return import.meta.dir.endsWith('/dist') ? bundledPath : sourcePath;
}

function loadRunnerService(): grpc.ServiceDefinition {
  const protocolRoot = locateProtocol();
  const definition = loadSync(resolve(protocolRoot, 'runner', 'v2', 'control.proto'), {
    defaults: false,
    // Keep enum values aligned with the numeric enums in the generated
    // TypeScript bindings used by transport handlers.
    enums: Number,
    keepCase: false,
    longs: String,
    oneofs: true,
    includeDirs: [protocolRoot],
  });
  const root = grpc.loadPackageDefinition(definition) as grpc.GrpcObject;
  const runner = root.runner as grpc.GrpcObject;
  const v2 = runner.v2 as grpc.GrpcObject;
  return (v2.RunnerTransportService as grpc.ServiceClientConstructor).service;
}

function defaultHandlers(
  config: RunnerGrpcConfig,
  sessions: RunnerGrpcSessionRegistry,
  controlNegotiation?: ControlNegotiationOptions,
  operations?: OperationsHandlerOptions,
  events?: EventsHandlerOptions,
  tunnel?: TunnelHandlerOptions,
  terminal?: TerminalHandlerOptions,
): RunnerGrpcHandlers {
  return {
    control: createControlNegotiationHandler(config, sessions, controlNegotiation),
    operations: createOperationsHandler(config, sessions, operations),
    events: createEventsHandler(sessions, events),
    tunnel: createTunnelHandler(config, sessions, tunnel),
    terminal: createTerminalHandler(config, sessions, terminal),
  };
}

function bind(server: grpc.Server, address: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    // Public TLS terminates at the deployment ingress; its private HTTP/2 hop
    // reaches this dedicated listener. Runner credentials are still required.
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else resolvePort(port);
    });
  });
}

export async function startRunnerGrpcEndpoint(
  options?: RunnerGrpcEndpointOptions,
): Promise<RunnerGrpcEndpoint | null> {
  const config = options?.config ?? resolveRunnerGrpcConfig();
  if (!config.enabled) {
    log.info('Runner gRPC endpoint disabled', { namespace: 'runner-grpc' });
    return null;
  }

  const runnerManager = options?.dependencies ? null : await import('../runner-manager.js');
  const dependencies: RunnerGrpcDependencies = options?.dependencies ?? {
    authenticateRunner: runnerManager!.authenticateRunner,
    getRunnerUserId: runnerManager!.getRunnerUserId,
    markRunnerOnline: runnerManager!.markRunnerOnline,
    markRunnerOffline: runnerManager!.markRunnerOffline,
  };
  const sessions =
    options?.sessionRegistry ??
    new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      onAvailable: async (runnerId, _epoch, userId) => {
        log.info('Runner connected via gRPC', { namespace: 'runner-grpc', runnerId });
        if (userId) {
          relayToUser(userId, { type: 'runner:status', status: 'online', runnerId });
        }
        await dependencies.markRunnerOnline?.(runnerId);
      },
      onHeartbeat: (runnerId) => dependencies.markRunnerOnline?.(runnerId),
      onUnavailable: async (runnerId, _epoch, _reason, userId) => {
        log.info('Runner disconnected from gRPC', { namespace: 'runner-grpc', runnerId });
        if (userId && !sessions.userHasAvailableRunner(userId)) {
          relayToUser(userId, { type: 'runner:status', status: 'offline', runnerId });
        }
        await dependencies.markRunnerOffline?.(runnerId);
      },
      onTransitionError: (error, runnerId) => {
        log.error('Runner gRPC presence transition failed', {
          namespace: 'runner-grpc',
          runnerId,
          errorType: error instanceof Error ? error.name : 'unknown',
        });
      },
    });
  const eventReceipts: EventReceiptStore = options?.events?.receipts ?? new SqlEventReceiptStore();
  const tunnelDispatcher =
    options?.tunnel?.dispatcher ?? new RunnerGrpcTunnelDispatcher(config, sessions);
  const terminalDispatcher =
    options?.terminal?.dispatcher ??
    new RunnerGrpcTerminalDispatcher(
      config,
      sessions,
      options?.terminal?.relayToUser ?? relayToUser,
    );
  const controlNegotiation: ControlNegotiationOptions = options?.controlNegotiation
    ?.resolveResumeCursors
    ? options.controlNegotiation
    : {
        ...options?.controlNegotiation,
        resolveResumeCursors: async (context, hello) => ({
          eventCursors: await Promise.all(
            hello.eventCursors.map(async (cursor) => ({
              executionId: cursor.executionId,
              lastAcceptedSequence: await eventReceipts.highestAccepted(
                context.principal.runnerId,
                cursor.executionId,
              ),
            })),
          ),
          terminalCursors: [],
        }),
      };
  const handlers = {
    ...defaultHandlers(
      config,
      sessions,
      controlNegotiation,
      options?.operations,
      { ...options?.events, receipts: eventReceipts },
      { ...options?.tunnel, dispatcher: tunnelDispatcher },
      { ...options?.terminal, dispatcher: terminalDispatcher },
    ),
    ...options?.handlers,
  };
  const limiter = new RunnerStreamLimiter(config.maxConcurrentStreamsPerRunner);
  const server = new grpc.Server({
    'grpc.max_receive_message_length': config.maxMessageBytes,
    'grpc.max_send_message_length': config.maxMessageBytes,
  });
  server.addService(
    loadRunnerService(),
    Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        createRunnerGrpcInterceptor(method, handler, dependencies, config, limiter),
      ]),
    ),
  );

  const port = await bind(server, `${config.host}:${config.port}`);
  log.info('Runner gRPC endpoint listening', {
    namespace: 'runner-grpc',
    host: config.host,
    port,
    maxMessageBytes: config.maxMessageBytes,
    maxConcurrentStreamsPerRunner: config.maxConcurrentStreamsPerRunner,
  });

  return {
    host: config.host,
    port,
    requests: new GrpcRunnerRequestAdapter(tunnelDispatcher),
    terminals: terminalDispatcher,
    presence: sessions,
    shutdown: (graceMs = 4_000) =>
      new Promise<void>((resolveShutdown) => {
        sessions.closeAll();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          resolveShutdown();
        };
        const forceTimer = setTimeout(() => {
          server.forceShutdown();
          finish();
        }, graceMs);
        forceTimer.unref();
        server.tryShutdown((error) => {
          if (error) server.forceShutdown();
          finish();
        });
      }),
  };
}
