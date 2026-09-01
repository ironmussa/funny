import { isTextualContentType } from '@funny/shared/runner-protocol';
import { FailureCode } from '@funny/shared/runner-v2/common';

import {
  RunnerRequestTimeoutError,
  type RunnerRequest,
  type RunnerRequestPort,
  type RunnerResponse,
} from '../runner-ports.js';
import { RunnerGrpcTunnelDispatcher, TunnelDispatchError } from './tunnel-handler.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPACITY_RETRY_DELAY_MS = 50;

function waitForCapacity(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new TunnelDispatchError('tunnel request cancelled', FailureCode.CANCELLED),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new TunnelDispatchError('tunnel request cancelled', FailureCode.CANCELLED));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Adapts framed gRPC tunnel exchanges to the request capability used by HTTP handlers. */
export class GrpcRunnerRequestAdapter implements RunnerRequestPort {
  constructor(
    private readonly dispatcher: RunnerGrpcTunnelDispatcher,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  isAvailable(runnerId: string): boolean {
    return this.dispatcher.isConnected(runnerId);
  }

  async request(runnerId: string, request: RunnerRequest): Promise<RunnerResponse> {
    if (!this.isAvailable(runnerId)) {
      throw new Error(`Runner ${runnerId} has no active gRPC tunnel`);
    }
    const deadlineAt = request.deadlineAt ?? Date.now() + this.timeoutMs;
    try {
      const dispatchRequest = {
        method: request.method,
        path: request.path,
        headers: Object.entries(request.headers).map(([name, value]) => ({ name, value })),
        body:
          request.body == null
            ? undefined
            : typeof request.body === 'string'
              ? Buffer.from(request.body, 'utf8')
              : request.body,
        deadlineAt,
        signal: request.signal,
      };
      let retryDelayMs = 5;
      let exchange: ReturnType<RunnerGrpcTunnelDispatcher['dispatch']>;
      for (;;) {
        try {
          exchange = this.dispatcher.dispatch(runnerId, dispatchRequest);
          break;
        } catch (error) {
          if (
            !(error instanceof TunnelDispatchError) ||
            error.code !== FailureCode.RESOURCE_EXHAUSTED ||
            !error.retryable
          ) {
            throw error;
          }
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) {
            throw new TunnelDispatchError(
              'tunnel deadline exceeded while waiting for capacity',
              FailureCode.DEADLINE_EXCEEDED,
              true,
            );
          }
          await waitForCapacity(Math.min(retryDelayMs, remainingMs), request.signal);
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_CAPACITY_RETRY_DELAY_MS);
        }
      }
      const head = await exchange.response;
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      for await (const chunk of exchange.body) {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
      }
      await exchange.completed;
      const bytes = Buffer.allocUnsafe(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const headers = Object.fromEntries(head.headers.map(({ name, value }) => [name, value]));
      const textual = isTextualContentType(headers['content-type']);
      return {
        status: head.statusCode,
        headers,
        body: textual ? bytes.toString('utf8') : bytes.toString('base64'),
        bodyEncoding: textual ? 'utf8' : 'base64',
      };
    } catch (error) {
      if (error instanceof TunnelDispatchError && error.code === FailureCode.DEADLINE_EXCEEDED) {
        throw new RunnerRequestTimeoutError(runnerId, Math.max(1, deadlineAt - Date.now()));
      }
      throw error;
    }
  }
}
