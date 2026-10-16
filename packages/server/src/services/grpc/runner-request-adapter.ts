import { retryAsync } from '@funny/shared/async';
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

const FIRST_CAPACITY_RETRY_DELAY_MS = 5;

function isCapacityError(error: unknown): boolean {
  return (
    error instanceof TunnelDispatchError &&
    error.code === FailureCode.RESOURCE_EXHAUSTED &&
    error.retryable
  );
}

/** Exponential backoff while the tunnel is out of capacity, bounded by the request deadline. */
function dispatchWithCapacityRetry<T>(
  dispatch: () => T,
  firstError: unknown,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadlineExceeded = () =>
    new TunnelDispatchError(
      'tunnel deadline exceeded while waiting for capacity',
      FailureCode.DEADLINE_EXCEEDED,
      true,
    );
  return retryAsync(
    async (_signal, attempt) => {
      // Attempt 1 is the synchronous fast-path failure the caller already observed.
      if (attempt === 1) throw firstError;
      if (deadlineAt - Date.now() <= 0) throw deadlineExceeded();
      return dispatch();
    },
    {
      signal,
      while: isCapacityError,
      delayMs: (retry) =>
        Math.min(
          FIRST_CAPACITY_RETRY_DELAY_MS * 2 ** (retry - 1),
          MAX_CAPACITY_RETRY_DELAY_MS,
          Math.max(0, deadlineAt - Date.now()),
        ),
    },
  ).catch((error) => {
    if (signal?.aborted)
      throw new TunnelDispatchError('tunnel request cancelled', FailureCode.CANCELLED);
    throw error;
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
      let exchange: ReturnType<RunnerGrpcTunnelDispatcher['dispatch']>;
      const dispatch = () => this.dispatcher.dispatch(runnerId, dispatchRequest);
      try {
        // Fast path stays synchronous; only a saturated tunnel enters the backoff schedule.
        exchange = dispatch();
      } catch (error) {
        if (!isCapacityError(error)) throw error;
        exchange = await dispatchWithCapacityRetry(dispatch, error, deadlineAt, request.signal);
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
