import { RUNNER_GRPC_MAX_MESSAGE_BYTES } from '@funny/shared/runner-protocol';
import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';
import { binary, unsigned } from './grpc-wire-values.js';

/**
 * Largest request body the adapter assembles in memory before it dispatches
 * the request. Larger bodies fail with RESOURCE_EXHAUSTED instead of growing
 * the runner's heap without bound.
 */
const DEFAULT_MAX_TUNNEL_REQUEST_BODY_BYTES = RUNNER_GRPC_MAX_MESSAGE_BYTES;

type TunnelRequestState = {
  method: string;
  path: string;
  headers: Array<{ name: string; value: string }>;
  chunks: Uint8Array[];
  bodyBytes: number;
  sequence: bigint;
  controller: AbortController;
  responding: boolean;
  /** The session the request arrived on; its frames never go to another one. */
  session: number;
};

export interface RunnerTunnelSender {
  /** Returns `false` when the stream is gone or its write buffer is full. */
  send(name: 'tunnel', message: RunnerGrpcWireMessage): boolean;
  /**
   * Resolves `true` once a full write buffer drains, `false` when the session
   * ended first. Without it the adapter cannot wait and stops the response.
   */
  waitForDrain?(name: 'tunnel'): Promise<boolean>;
}

/**
 * Frames gRPC tunnel requests into local Fetch requests and response frames.
 * Every request belongs to the session it arrived on: a disconnect aborts it,
 * and nothing it produces afterwards is sent on a later session.
 */
export class RunnerTunnelAdapter {
  private readonly requests = new Map<string, TunnelRequestState>();
  private maxFrameBytes = 64 * 1024;
  private maxRequestBodyBytes = DEFAULT_MAX_TUNNEL_REQUEST_BODY_BYTES;
  private session = 0;

  constructor(
    private readonly sender: RunnerTunnelSender,
    private readonly handle?: (request: Request, signal: AbortSignal) => Promise<Response>,
  ) {}

  setMaxFrameBytes(value: number): void {
    if (Number.isSafeInteger(value) && value > 0) this.maxFrameBytes = value;
  }

  setMaxRequestBodyBytes(value: number): void {
    if (Number.isSafeInteger(value) && value > 0) this.maxRequestBodyBytes = value;
  }

  receive(message: RunnerGrpcWireMessage): void {
    const tunnelId = String(message.tunnelId ?? '');
    if (!tunnelId) return;
    if (message.cancel) {
      this.requests.get(tunnelId)?.controller.abort(message.cancel.reason ?? 'tunnel cancelled');
      this.requests.delete(tunnelId);
      return;
    }
    if (message.requestStart) {
      // A reused id replaces the old exchange; never leave it running unowned.
      this.requests.get(tunnelId)?.controller.abort('tunnel request replaced');
      this.requests.set(tunnelId, {
        method: String(message.requestStart.method ?? 'GET'),
        path: String(message.requestStart.path ?? '/'),
        headers: Array.isArray(message.requestStart.headers) ? message.requestStart.headers : [],
        chunks: [],
        bodyBytes: 0,
        sequence: 0n,
        controller: new AbortController(),
        responding: false,
        session: this.session,
      });
      return;
    }
    const state = this.requests.get(tunnelId);
    if (!state) return;
    if (state.responding) {
      this.fail(tunnelId, state, FailureCode.INVALID_ARGUMENT, 'tunnel request already ended');
      return;
    }
    if (message.data) {
      this.receiveData(tunnelId, state, message.data);
      return;
    }
    if (message.end) {
      // A protobuf uint64 equal to zero may be omitted on decode. Zero is the
      // valid final sequence for requests without a body.
      const finalSequence = unsigned(message.end.finalSequence ?? 0);
      if (finalSequence !== state.sequence) {
        this.fail(tunnelId, state, FailureCode.INVALID_ARGUMENT, 'invalid tunnel request end');
        return;
      }
      state.responding = true;
      void this.respond(tunnelId, state);
    }
  }

  private receiveData(
    tunnelId: string,
    state: TunnelRequestState,
    frame: RunnerGrpcWireMessage,
  ): void {
    const sequence = unsigned(frame.sequence);
    const data = binary(frame.data);
    if (sequence !== state.sequence + 1n || !data || data.byteLength > this.maxFrameBytes) {
      this.fail(tunnelId, state, FailureCode.INVALID_ARGUMENT, 'invalid tunnel request data');
      return;
    }
    if (state.bodyBytes + data.byteLength > this.maxRequestBodyBytes) {
      this.fail(
        tunnelId,
        state,
        FailureCode.RESOURCE_EXHAUSTED,
        'tunnel request body exceeds the configured limit',
      );
      return;
    }
    state.sequence = sequence;
    state.bodyBytes += data.byteLength;
    state.chunks.push(data);
  }

  /**
   * Ends the current session: aborts every in-flight request and makes sure
   * none of them writes a frame on the next session. Called on every
   * disconnect, not only on transport shutdown.
   */
  shutdown(reason = 'gRPC transport shut down'): void {
    this.session++;
    for (const request of this.requests.values()) request.controller.abort(reason);
    this.requests.clear();
  }

  private isCurrent(tunnelId: string, state: TunnelRequestState): boolean {
    return (
      state.session === this.session &&
      !state.controller.signal.aborted &&
      this.requests.get(tunnelId) === state
    );
  }

  /** Sends one frame, waiting out backpressure. `false` stops the response. */
  private async write(
    tunnelId: string,
    state: TunnelRequestState,
    message: RunnerGrpcWireMessage,
  ): Promise<boolean> {
    if (!this.isCurrent(tunnelId, state)) return false;
    if (this.sender.send('tunnel', { tunnelId, ...message })) return true;
    // The frame was queued, or the stream is gone. Either way do not produce
    // another one until the buffer drains on this same session.
    const drained = (await this.sender.waitForDrain?.('tunnel')) ?? false;
    if (!drained) state.controller.abort('tunnel stream is not writable');
    return drained && this.isCurrent(tunnelId, state);
  }

  private async respond(tunnelId: string, state: TunnelRequestState): Promise<void> {
    if (!this.handle)
      return this.fail(
        tunnelId,
        state,
        FailureCode.UNAVAILABLE,
        'local application is unavailable',
      );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.handle(buildLocalRequest(state), state.controller.signal);
      reader = response.body?.getReader();
      if (!(await this.deliver(tunnelId, state, response, reader)))
        return this.abandon(tunnelId, state, reader);
      if (this.requests.get(tunnelId) === state) this.requests.delete(tunnelId);
    } catch {
      void reader?.cancel().catch(() => undefined);
      const cancelled = state.controller.signal.aborted;
      this.fail(
        tunnelId,
        state,
        cancelled ? FailureCode.CANCELLED : FailureCode.INTERNAL,
        cancelled ? 'tunnel request cancelled' : 'local tunnel request failed',
      );
    }
  }

  /** Streams the local response; `false` when it could not be delivered. */
  private async deliver(
    tunnelId: string,
    state: TunnelRequestState,
    response: Response,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  ): Promise<boolean> {
    const headers: Array<{ name: string; value: string }> = [];
    response.headers.forEach((value, name) => headers.push({ name, value }));
    if (
      !(await this.write(tunnelId, state, {
        responseStart: { statusCode: response.status, headers },
      }))
    )
      return false;
    let sequence = 0n;
    for (;;) {
      const next = reader ? await reader.read() : { done: true as const, value: undefined };
      if (next.done) break;
      for (const chunk of frames(next.value, this.maxFrameBytes)) {
        const data = { sequence: String(++sequence), data: Buffer.from(chunk).toString('base64') };
        if (!(await this.write(tunnelId, state, { data }))) return false;
      }
    }
    return this.write(tunnelId, state, { end: { finalSequence: String(sequence) } });
  }

  /** Stops a response that can no longer be delivered on its session. */
  private abandon(
    tunnelId: string,
    state: TunnelRequestState,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  ): void {
    if (!state.controller.signal.aborted) state.controller.abort('tunnel request abandoned');
    void reader?.cancel().catch(() => undefined);
    if (this.requests.get(tunnelId) === state) this.requests.delete(tunnelId);
  }

  private fail(
    tunnelId: string,
    state: TunnelRequestState,
    code: FailureCode,
    message: string,
  ): void {
    if (this.requests.get(tunnelId) === state) this.requests.delete(tunnelId);
    if (!state.controller.signal.aborted) state.controller.abort(message);
    // A request from an ended session has no one to report to.
    if (state.session !== this.session) return;
    this.sender.send('tunnel', { tunnelId, failure: { code, message, retryable: false } });
  }
}

function buildLocalRequest(state: TunnelRequestState): Request {
  const headers = new Headers();
  for (const header of state.headers) headers.append(header.name, header.value);
  const hasBody = state.chunks.length > 0 && state.method !== 'GET' && state.method !== 'HEAD';
  const body = hasBody ? Buffer.concat(state.chunks.map((chunk) => Buffer.from(chunk))) : undefined;
  state.chunks = [];
  return new Request(`http://runner.local${state.path}`, {
    method: state.method,
    headers,
    body,
    signal: state.controller.signal,
  });
}

function* frames(value: Uint8Array, maximum: number): Generator<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += maximum) {
    yield value.subarray(offset, Math.min(offset + maximum, value.byteLength));
  }
}
