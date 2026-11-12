import type { EndpointPolicy } from './endpoint-policy';
import type { ClientCancellation, TransportService } from './platform';

export type ApiErrorType =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'PROCESS_ERROR'
  | 'CONFLICT'
  | 'INTERNAL';

export interface ApiClientError {
  type: ApiErrorType;
  message: string;
  friendlyMessage?: string;
  exitCode?: number;
  stderr?: string;
}

export interface ApiRequestInit {
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  cancellation?: ClientCancellation;
}

export interface ApiSpan {
  traceparent: string;
  end(status?: 'OK' | 'ERROR', errorMessage?: string): void;
}

export interface ApiTelemetry {
  reportFailure?(failure: {
    kind: 'http' | 'network';
    method: string;
    path: string;
    projectId?: string;
    status: number;
    error: string;
    durationMs: number;
    traceparent: string;
  }): void;
  startSpan(name: string, options: { attributes: Record<string, string | number> }): ApiSpan;
  metric(
    name: string,
    value: number,
    options: { type: 'gauge'; attributes: Record<string, string> },
  ): void;
}

export interface CircuitBreakerActions {
  snapshot(): { state: 'closed' | 'open' | 'half-open' };
  recordFailure(): void;
  recordSuccess(): void;
}

export interface ApiClientDependencies {
  transport: TransportService;
  endpointPolicy: EndpointPolicy;
  clock(): number;
  telemetry: ApiTelemetry;
  circuitBreaker: CircuitBreakerActions;
  onUnauthorized(path: string): void;
  networkFriendlyMessage(): string;
}

export interface ApiClient {
  request<T>(path: string, init?: ApiRequestInit): Promise<T>;
}

function isGitDiffReadRequest(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  const pathname = path.split('?')[0];
  return /^\/git\/(?:project\/[^/]+|[^/]+)\/diff(?:\/|$)/.test(pathname);
}

function parseBody(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A tRPC procedure answers `{ error: { message, friendlyMessage?, data: { httpStatus } } }`
 * where a REST route answers `{ error: string, friendlyMessage? }`; read both the same way.
 */
function flattenTrpcError(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as
    | { message?: unknown; friendlyMessage?: unknown; data?: { httpStatus?: unknown } }
    | undefined;
  if (
    !error ||
    typeof error !== 'object' ||
    typeof error.message !== 'string' ||
    typeof error.data?.httpStatus !== 'number'
  ) {
    return body;
  }
  return typeof error.friendlyMessage === 'string'
    ? { error: error.message, friendlyMessage: error.friendlyMessage }
    : { error: error.message };
}

function httpErrorMessage(body: Record<string, unknown>, status: number): string {
  const rawError = body.error;
  if (typeof rawError === 'string' && rawError.length > 0) return rawError;
  return rawError ? JSON.stringify(rawError) : `HTTP ${status}`;
}

const HTTP_STATUS_TYPES: Record<number, ApiErrorType> = {
  404: 'NOT_FOUND',
  403: 'FORBIDDEN',
  409: 'CONFLICT',
};

/** The error thrown for a non-OK HTTP response. */
function httpError(body: Record<string, unknown>, status: number, message: string): ApiClientError {
  if (body.stderr || body.exitCode != null) {
    return {
      type: 'PROCESS_ERROR',
      message,
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : undefined,
      stderr: typeof body.stderr === 'string' ? body.stderr : undefined,
    };
  }
  const type = HTTP_STATUS_TYPES[status] ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
  // A server message written for the user replaces the generic per-type text.
  const { friendlyMessage } = body;
  return typeof friendlyMessage === 'string' && friendlyMessage.length > 0
    ? { type, message, friendlyMessage }
    : { type, message };
}

function asApiError(error: unknown): ApiClientError {
  if (error && typeof error === 'object' && 'type' in error && 'message' in error) {
    return error as ApiClientError;
  }
  return { type: 'INTERNAL', message: String(error) };
}

export function createApiClient(dependencies: ApiClientDependencies): ApiClient {
  // One connection drop fails every request in flight at that moment (a thread
  // switch fires several in parallel). Count that burst as a single failure:
  // a request only counts if it started after the last counted failure, so a
  // real outage still opens the circuit after `failureThreshold` sequential
  // failures, but one blip no longer does.
  let lastCountedFailureAt = Number.NEGATIVE_INFINITY;
  const recordFailure = (startedAt: number): void => {
    if (startedAt <= lastCountedFailureAt) return;
    lastCountedFailureAt = dependencies.clock();
    dependencies.circuitBreaker.recordFailure();
  };

  return {
    async request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
      const method = init.method ?? 'GET';
      const span = dependencies.telemetry.startSpan('http.client', {
        attributes: { 'http.method': method, 'http.url': path },
      });
      const startedAt = dependencies.clock();
      const reportFailure = (kind: 'http' | 'network', status: number, error: string) => {
        // Keep request bodies, headers, and arbitrary query values out of logs.
        const [pathname, query] = path.split('?');
        try {
          dependencies.telemetry.reportFailure?.({
            kind,
            method,
            path: pathname,
            projectId: new URLSearchParams(query).get('projectId') ?? undefined,
            status,
            error: error.slice(0, 2048),
            durationMs: dependencies.clock() - startedAt,
            traceparent: span.traceparent,
          });
        } catch {
          // A diagnostic sink must never change the request's result.
        }
      };

      if (dependencies.circuitBreaker.snapshot().state === 'open') {
        span.end('ERROR');
        throw {
          type: 'INTERNAL',
          message: 'Server unavailable (circuit open)',
          friendlyMessage: dependencies.networkFriendlyMessage(),
        } satisfies ApiClientError;
      }

      let response;
      try {
        response = await dependencies.transport.request({
          url: `${dependencies.endpointPolicy.apiBase}${path}`,
          method,
          body: init.body,
          cancellation: init.cancellation,
          headers: {
            'Content-Type': 'application/json',
            traceparent: span.traceparent,
            ...init.headers,
          },
        });
      } catch (error) {
        span.end('ERROR');
        if (init.cancellation?.aborted || (error as { name?: string })?.name === 'AbortError') {
          throw { type: 'INTERNAL', message: 'Request aborted' } satisfies ApiClientError;
        }
        recordFailure(startedAt);
        reportFailure('network', 0, String(error));
        dependencies.telemetry.metric('http.client.duration', dependencies.clock() - startedAt, {
          type: 'gauge',
          attributes: { method, path, status: '0' },
        });
        throw {
          type: 'INTERNAL',
          message: String(error),
          friendlyMessage: dependencies.networkFriendlyMessage(),
        } satisfies ApiClientError;
      }

      dependencies.telemetry.metric('http.client.duration', dependencies.clock() - startedAt, {
        type: 'gauge',
        attributes: { method, path, status: String(response.status) },
      });
      if (!response.ok) {
        span.end('ERROR');
        const pathNoQuery = path.split('?')[0];
        if (response.status === 401 && !(method === 'GET' && pathNoQuery === '/profile')) {
          dependencies.onUnauthorized(pathNoQuery);
        }
        if (
          response.status >= 500 &&
          response.status !== 502 &&
          response.status !== 504 &&
          !isGitDiffReadRequest(method, path)
        ) {
          recordFailure(startedAt);
        }
        const responseText = await response.text().catch(() => '');
        const body = flattenTrpcError(parseBody(responseText));
        const message = httpErrorMessage(body, response.status);
        reportFailure('http', response.status, message);
        throw httpError(body, response.status, message);
      }

      span.end('OK');
      dependencies.circuitBreaker.recordSuccess();
      try {
        const responseText = await response.text();
        return JSON.parse(responseText) as T;
      } catch (error) {
        throw asApiError(error);
      }
    },
  };
}
