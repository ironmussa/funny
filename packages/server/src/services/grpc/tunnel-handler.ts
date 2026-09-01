import { randomUUID } from 'node:crypto';

import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcConfig } from './config.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
  RunnerGrpcHandler,
} from './runner-grpc-server.js';
import type { RunnerGrpcSessionRegistry } from './session-registry.js';

type Header = { name: string; value: string };
type WireFrame = Record<string, any> & {
  session?: { sessionEpoch?: string | number | bigint };
  tunnelId?: string;
  responseStart?: { statusCode?: number; headers?: Header[] };
  data?: { sequence?: string | number | bigint; data?: Uint8Array };
  end?: { finalSequence?: string | number | bigint };
  failure?: { code?: FailureCode; message?: string; retryable?: boolean };
  ready?: Record<string, never>;
};

export interface TunnelDispatchRequest {
  method: string;
  path: string;
  headers?: Header[];
  body?: Uint8Array | AsyncIterable<Uint8Array>;
  deadlineAt: number;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface TunnelResponseHead {
  statusCode: number;
  headers: Header[];
}

export interface TunnelExchange {
  tunnelId: string;
  response: Promise<TunnelResponseHead>;
  body: AsyncIterable<Uint8Array>;
  completed: Promise<void>;
  cancel(reason?: string): void;
}

export class TunnelDispatchError extends Error {
  constructor(
    message: string,
    readonly code: FailureCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TunnelDispatchError';
  }
}

interface AttachedStream {
  call: RunnerGrpcCall;
  epoch: bigint;
  tunnels: Map<string, TunnelState>;
}

interface TunnelState {
  id: string;
  stream: AttachedStream;
  responseSequence: bigint;
  responseStarted: boolean;
  bufferedBytes: number;
  chunks: Uint8Array[];
  readers: Array<{
    resolve(value: IteratorResult<Uint8Array>): void;
    reject(error: unknown): void;
  }>;
  responseResolve(value: TunnelResponseHead): void;
  responseReject(error: unknown): void;
  completedResolve(): void;
  completedReject(error: unknown): void;
  settled: boolean;
  error?: TunnelDispatchError;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

function parseUnsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function timestamp(epochMs: number): { seconds: string; nanos: number } {
  return {
    seconds: String(Math.floor(epochMs / 1_000)),
    nanos: (epochMs % 1_000) * 1_000_000,
  };
}

function waitUntilWritable(call: RunnerGrpcCall): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      call.off('drain', onDrain);
      call.off('error', onError);
      call.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('tunnel stream closed'));
    };
    call.once('drain', onDrain);
    call.once('error', onError);
    call.once('close', onClose);
  });
}

async function* bodyChunks(
  body: TunnelDispatchRequest['body'],
  maximum: number,
): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const source = body instanceof Uint8Array ? [body] : body;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TunnelDispatchError(
        'tunnel request body chunks must be binary',
        FailureCode.INVALID_ARGUMENT,
      );
    }
    for (let offset = 0; offset < chunk.byteLength; offset += maximum) {
      yield chunk.subarray(offset, Math.min(offset + maximum, chunk.byteLength));
    }
  }
}

/**
 * Owns runner-initiated tunnel streams and exposes independently cancellable,
 * framed HTTP exchanges to server-side adapters.
 */
export class RunnerGrpcTunnelDispatcher {
  private readonly streams = new Map<string, AttachedStream>();

  constructor(
    private readonly config: RunnerGrpcConfig,
    private readonly sessions: RunnerGrpcSessionRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  isConnected(runnerId: string): boolean {
    const stream = this.streams.get(runnerId);
    return !!stream && this.sessions.isActive(runnerId, stream.epoch);
  }

  activeTunnelCount(runnerId: string): number {
    return this.streams.get(runnerId)?.tunnels.size ?? 0;
  }

  attach(runnerId: string, epoch: bigint, call: RunnerGrpcCall): () => void {
    const previous = this.streams.get(runnerId);
    if (previous) this.failStream(previous, 'tunnel stream was replaced');
    const stream: AttachedStream = { call, epoch, tunnels: new Map() };
    this.streams.set(runnerId, stream);
    return () => {
      if (this.streams.get(runnerId) !== stream) return;
      this.streams.delete(runnerId);
      this.failStream(stream, 'tunnel stream closed');
    };
  }

  dispatch(runnerId: string, request: TunnelDispatchRequest): TunnelExchange {
    const stream = this.streams.get(runnerId);
    if (!stream || !this.sessions.isActive(runnerId, stream.epoch)) {
      throw new TunnelDispatchError(
        'runner tunnel stream is unavailable',
        FailureCode.UNAVAILABLE,
        true,
      );
    }
    if (stream.tunnels.size >= this.config.maxActiveTunnels) {
      throw new TunnelDispatchError(
        'active tunnel limit exceeded',
        FailureCode.RESOURCE_EXHAUSTED,
        true,
      );
    }
    if (!request.method || !request.path || !Number.isFinite(request.deadlineAt)) {
      throw new TunnelDispatchError(
        'tunnel method, path, and deadline are required',
        FailureCode.INVALID_ARGUMENT,
      );
    }
    if (request.deadlineAt <= this.now()) {
      throw new TunnelDispatchError(
        'tunnel deadline exceeded',
        FailureCode.DEADLINE_EXCEEDED,
        true,
      );
    }

    const tunnelId = randomUUID();
    const responseDeferred = Promise.withResolvers<TunnelResponseHead>();
    const completedDeferred = Promise.withResolvers<void>();
    // A body consumer may be attached after response headers arrive. Suppress
    // process-level unhandled rejection reporting while preserving rejection
    // for the eventual consumer.
    void responseDeferred.promise.catch(() => undefined);
    void completedDeferred.promise.catch(() => undefined);
    const state: TunnelState = {
      id: tunnelId,
      stream,
      responseSequence: 0n,
      responseStarted: false,
      bufferedBytes: 0,
      chunks: [],
      readers: [],
      responseResolve: responseDeferred.resolve,
      responseReject: responseDeferred.reject,
      completedResolve: completedDeferred.resolve,
      completedReject: completedDeferred.reject,
      settled: false,
      timer: setTimeout(
        () => {
          this.cancel(state, 'tunnel deadline exceeded', FailureCode.DEADLINE_EXCEEDED, true);
        },
        Math.min(2_147_483_647, Math.max(1, request.deadlineAt - this.now())),
      ),
    };
    state.timer.unref();
    stream.tunnels.set(tunnelId, state);

    if (request.signal) {
      const onAbort = () => this.cancel(state, 'tunnel request cancelled', FailureCode.CANCELLED);
      request.signal.addEventListener('abort', onAbort, { once: true });
      state.removeAbortListener = () => request.signal?.removeEventListener('abort', onAbort);
      if (request.signal.aborted) onAbort();
    }

    const metadata = {
      correlationId: request.correlationId || tunnelId,
      deadline: timestamp(request.deadlineAt),
    };
    if (!state.settled) {
      const writable = stream.call.write({
        session: { sessionEpoch: String(stream.epoch) },
        tunnelId,
        metadata,
        requestStart: {
          method: request.method,
          path: request.path,
          headers: request.headers ?? [],
        },
      });
      void this.sendBody(
        state,
        request.body,
        metadata,
        writable ? undefined : waitUntilWritable(stream.call),
      );
    }

    return {
      tunnelId,
      response: responseDeferred.promise,
      body: this.readBody(state),
      completed: completedDeferred.promise,
      cancel: (reason = 'tunnel request cancelled') =>
        this.cancel(state, reason, FailureCode.CANCELLED),
    };
  }

  receive(runnerId: string, epoch: bigint, frame: WireFrame): void {
    const stream = this.streams.get(runnerId);
    if (!stream || stream.epoch !== epoch || !this.sessions.isActive(runnerId, epoch)) return;
    const tunnelId = frame.tunnelId ?? '';
    const state = stream.tunnels.get(tunnelId);
    if (!state) {
      stream.call.write({
        session: { sessionEpoch: String(epoch) },
        tunnelId,
        failure: {
          code: FailureCode.NOT_FOUND,
          message: 'tunnel is not active',
          retryable: false,
        },
      });
      return;
    }
    if (frame.failure) {
      this.fail(
        state,
        new TunnelDispatchError(
          frame.failure.message || 'runner tunnel failed',
          frame.failure.code ?? FailureCode.INTERNAL,
          !!frame.failure.retryable,
        ),
      );
      return;
    }
    if (frame.responseStart) {
      if (state.responseStarted || state.responseSequence !== 0n) {
        this.protocolFailure(state, 'duplicate or out-of-order tunnel response start');
        return;
      }
      const statusCode = frame.responseStart.statusCode ?? 0;
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        this.protocolFailure(state, 'invalid tunnel response status');
        return;
      }
      state.responseStarted = true;
      state.responseResolve({ statusCode, headers: frame.responseStart.headers ?? [] });
      return;
    }
    if (frame.data) {
      const sequence = parseUnsigned(frame.data.sequence);
      const data = frame.data.data;
      if (
        !state.responseStarted ||
        sequence === null ||
        sequence !== state.responseSequence + 1n ||
        !(data instanceof Uint8Array)
      ) {
        this.protocolFailure(state, 'out-of-order tunnel response data');
        return;
      }
      if (data.byteLength > this.config.maxFrameBytes) {
        this.resourceFailure(state, 'tunnel response frame exceeds the configured limit');
        return;
      }
      if (state.bufferedBytes + data.byteLength > this.config.maxBufferedBytesPerClass) {
        this.resourceFailure(state, 'tunnel response buffer exceeds the configured limit');
        return;
      }
      state.responseSequence = sequence;
      const reader = state.readers.shift();
      if (reader) reader.resolve({ value: data, done: false });
      else {
        state.chunks.push(data);
        state.bufferedBytes += data.byteLength;
      }
      return;
    }
    if (frame.end) {
      // protobufjs omits scalar uint64 fields whose value is zero, which is
      // the valid final sequence for a bodyless response.
      const finalSequence = parseUnsigned(frame.end.finalSequence ?? 0);
      if (!state.responseStarted || finalSequence !== state.responseSequence) {
        this.protocolFailure(state, 'tunnel response ended at an invalid sequence');
        return;
      }
      this.complete(state);
      return;
    }
    this.protocolFailure(state, 'tunnel response frame is missing a payload');
  }

  private async sendBody(
    state: TunnelState,
    body: TunnelDispatchRequest['body'],
    metadata: Record<string, unknown>,
    startBackpressure?: Promise<void>,
  ): Promise<void> {
    let sequence = 0n;
    try {
      await startBackpressure;
      for await (const data of bodyChunks(body, this.config.maxFrameBytes)) {
        if (state.settled) return;
        sequence += 1n;
        const writable = state.stream.call.write({
          session: { sessionEpoch: String(state.stream.epoch) },
          tunnelId: state.id,
          metadata,
          data: { sequence: String(sequence), data },
        });
        if (!writable) await waitUntilWritable(state.stream.call);
      }
      if (!state.settled) {
        state.stream.call.write({
          session: { sessionEpoch: String(state.stream.epoch) },
          tunnelId: state.id,
          metadata,
          end: { finalSequence: String(sequence) },
        });
      }
    } catch (error) {
      this.cancel(
        state,
        error instanceof Error ? error.message : 'tunnel request body failed',
        error instanceof TunnelDispatchError ? error.code : FailureCode.INTERNAL,
      );
    }
  }

  private async *readBody(state: TunnelState): AsyncGenerator<Uint8Array> {
    while (true) {
      const chunk = state.chunks.shift();
      if (chunk) {
        state.bufferedBytes -= chunk.byteLength;
        yield chunk;
        continue;
      }
      if (state.settled) {
        if (state.error) throw state.error;
        return;
      }
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        state.readers.push({ resolve, reject });
      });
      if (next.done) return;
      yield next.value;
    }
  }

  private protocolFailure(state: TunnelState, message: string): void {
    this.cancel(state, message, FailureCode.INVALID_ARGUMENT);
  }

  private resourceFailure(state: TunnelState, message: string): void {
    this.cancel(state, message, FailureCode.RESOURCE_EXHAUSTED, true);
  }

  private cancel(state: TunnelState, message: string, code: FailureCode, retryable = false): void {
    if (state.settled) return;
    state.stream.call.write({
      session: { sessionEpoch: String(state.stream.epoch) },
      tunnelId: state.id,
      cancel: { reason: message },
    });
    this.fail(state, new TunnelDispatchError(message, code, retryable));
  }

  private complete(state: TunnelState): void {
    if (state.settled) return;
    state.settled = true;
    this.release(state);
    for (const reader of state.readers.splice(0)) reader.resolve({ value: undefined, done: true });
    state.completedResolve();
  }

  private fail(state: TunnelState, error: TunnelDispatchError): void {
    if (state.settled) return;
    state.settled = true;
    state.error = error;
    this.release(state);
    if (!state.responseStarted) state.responseReject(error);
    for (const reader of state.readers.splice(0)) reader.reject(error);
    state.completedReject(error);
  }

  private release(state: TunnelState): void {
    clearTimeout(state.timer);
    state.removeAbortListener?.();
    state.stream.tunnels.delete(state.id);
  }

  private failStream(stream: AttachedStream, message: string): void {
    for (const state of [...stream.tunnels.values()]) {
      this.fail(state, new TunnelDispatchError(message, FailureCode.UNAVAILABLE, true));
    }
  }
}

export interface TunnelHandlerOptions {
  dispatcher?: RunnerGrpcTunnelDispatcher;
}

export function createTunnelHandler(
  config: RunnerGrpcConfig,
  sessions: RunnerGrpcSessionRegistry,
  options: TunnelHandlerOptions = {},
): RunnerGrpcHandler {
  const dispatcher = options.dispatcher ?? new RunnerGrpcTunnelDispatcher(config, sessions);
  return (call: RunnerGrpcCall, context: RunnerGrpcCallContext) => {
    let detach: (() => void) | undefined;
    let epoch: bigint | null = null;
    const close = () => detach?.();
    call.once('cancelled', close);
    call.once('close', close);
    call.once('error', close);
    call.on('data', (frame: WireFrame) => {
      const frameEpoch = parseUnsigned(frame.session?.sessionEpoch);
      if (frameEpoch === null || !sessions.isActive(context.principal.runnerId, frameEpoch)) {
        call.write({
          session: { sessionEpoch: String(frameEpoch ?? 0n) },
          tunnelId: frame.tunnelId ?? '',
          failure: {
            code: FailureCode.UNAVAILABLE,
            message: 'runner session is not active',
            retryable: true,
          },
        });
        return;
      }
      if (frame.ready) {
        if (detach || frame.tunnelId) {
          call.write({
            session: { sessionEpoch: String(frameEpoch) },
            tunnelId: frame.tunnelId ?? '',
            failure: {
              code: FailureCode.INVALID_ARGUMENT,
              message: 'invalid tunnel stream ready frame',
              retryable: false,
            },
          });
          return;
        }
        epoch = frameEpoch;
        detach = dispatcher.attach(context.principal.runnerId, frameEpoch, call);
        return;
      }
      if (!detach || epoch !== frameEpoch) {
        call.write({
          session: { sessionEpoch: String(frameEpoch) },
          tunnelId: frame.tunnelId ?? '',
          failure: {
            code: FailureCode.INVALID_ARGUMENT,
            message: 'tunnel stream must send ready before response frames',
            retryable: false,
          },
        });
        return;
      }
      dispatcher.receive(context.principal.runnerId, frameEpoch, frame);
    });
  };
}
