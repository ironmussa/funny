import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';

type TunnelRequestState = {
  method: string;
  path: string;
  headers: Array<{ name: string; value: string }>;
  chunks: Uint8Array[];
  sequence: bigint;
  controller: AbortController;
  responding: boolean;
};

export interface RunnerTunnelSender {
  send(name: 'tunnel', message: RunnerGrpcWireMessage): boolean;
}

function binary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function unsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Frames gRPC tunnel requests into local Fetch requests and response frames. */
export class RunnerTunnelAdapter {
  private readonly requests = new Map<string, TunnelRequestState>();
  private maxFrameBytes = 64 * 1024;

  constructor(
    private readonly sender: RunnerTunnelSender,
    private readonly handle?: (request: Request, signal: AbortSignal) => Promise<Response>,
  ) {}

  setMaxFrameBytes(value: number): void {
    if (Number.isSafeInteger(value) && value > 0) this.maxFrameBytes = value;
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
      this.requests.set(tunnelId, {
        method: String(message.requestStart.method ?? 'GET'),
        path: String(message.requestStart.path ?? '/'),
        headers: Array.isArray(message.requestStart.headers) ? message.requestStart.headers : [],
        chunks: [],
        sequence: 0n,
        controller: new AbortController(),
        responding: false,
      });
      return;
    }
    const state = this.requests.get(tunnelId);
    if (!state) return;
    if (state.responding) {
      this.fail(tunnelId, FailureCode.INVALID_ARGUMENT, 'tunnel request already ended');
      return;
    }
    if (message.data) {
      const sequence = unsigned(message.data.sequence);
      const data = binary(message.data.data);
      if (sequence !== state.sequence + 1n || !data || data.byteLength > this.maxFrameBytes) {
        this.fail(tunnelId, FailureCode.INVALID_ARGUMENT, 'invalid tunnel request data');
        return;
      }
      state.sequence = sequence;
      state.chunks.push(data);
      return;
    }
    if (message.end) {
      // A protobuf uint64 equal to zero may be omitted on decode. Zero is the
      // valid final sequence for requests without a body.
      const finalSequence = unsigned(message.end.finalSequence ?? 0);
      if (finalSequence !== state.sequence) {
        this.fail(tunnelId, FailureCode.INVALID_ARGUMENT, 'invalid tunnel request end');
        return;
      }
      state.responding = true;
      void this.respond(tunnelId, state);
    }
  }

  shutdown(reason = 'gRPC transport shut down'): void {
    for (const request of this.requests.values()) request.controller.abort(reason);
    this.requests.clear();
  }

  private async respond(tunnelId: string, state: TunnelRequestState): Promise<void> {
    if (!this.handle)
      return this.fail(tunnelId, FailureCode.UNAVAILABLE, 'local application is unavailable');
    try {
      const headers = new Headers();
      for (const header of state.headers) headers.append(header.name, header.value);
      const body = state.chunks.length
        ? Buffer.concat(state.chunks.map((chunk) => Buffer.from(chunk)))
        : undefined;
      const response = await this.handle(
        new Request(`http://runner.local${state.path}`, {
          method: state.method,
          headers,
          ...(body && state.method !== 'GET' && state.method !== 'HEAD' ? { body } : {}),
          signal: state.controller.signal,
        }),
        state.controller.signal,
      );
      const responseHeaders: Array<{ name: string; value: string }> = [];
      response.headers.forEach((value, name) => responseHeaders.push({ name, value }));
      this.sender.send('tunnel', {
        tunnelId,
        responseStart: { statusCode: response.status, headers: responseHeaders },
      });
      let sequence = 0n;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += this.maxFrameBytes) {
            const chunk = value.subarray(
              offset,
              Math.min(offset + this.maxFrameBytes, value.byteLength),
            );
            this.sender.send('tunnel', {
              tunnelId,
              data: { sequence: String(++sequence), data: Buffer.from(chunk).toString('base64') },
            });
          }
        }
      }
      this.sender.send('tunnel', { tunnelId, end: { finalSequence: String(sequence) } });
      if (this.requests.get(tunnelId) === state) this.requests.delete(tunnelId);
    } catch {
      const cancelled = state.controller.signal.aborted;
      this.fail(
        tunnelId,
        cancelled ? FailureCode.CANCELLED : FailureCode.INTERNAL,
        cancelled ? 'tunnel request cancelled' : 'local tunnel request failed',
      );
    }
  }

  private fail(tunnelId: string, code: FailureCode, message: string): void {
    this.requests.delete(tunnelId);
    this.sender.send('tunnel', { tunnelId, failure: { code, message, retryable: false } });
  }
}
