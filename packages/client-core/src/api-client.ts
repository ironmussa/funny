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

function asApiError(error: unknown): ApiClientError {
  if (error && typeof error === 'object' && 'type' in error && 'message' in error) {
    return error as ApiClientError;
  }
  return { type: 'INTERNAL', message: String(error) };
}

export function createApiClient(dependencies: ApiClientDependencies): ApiClient {
  return {
    async request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
      const method = init.method ?? 'GET';
      const span = dependencies.telemetry.startSpan('http.client', {
        attributes: { 'http.method': method, 'http.url': path },
      });
      const startedAt = dependencies.clock();

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
        dependencies.circuitBreaker.recordFailure();
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
          dependencies.circuitBreaker.recordFailure();
        }
        const responseText = await response.text().catch(() => '');
        const body = parseBody(responseText);
        const rawError = body.error;
        const message =
          typeof rawError === 'string' && rawError.length > 0
            ? rawError
            : rawError
              ? JSON.stringify(rawError)
              : `HTTP ${response.status}`;
        if (body.stderr || body.exitCode != null) {
          throw {
            type: 'PROCESS_ERROR',
            message,
            exitCode: typeof body.exitCode === 'number' ? body.exitCode : undefined,
            stderr: typeof body.stderr === 'string' ? body.stderr : undefined,
          } satisfies ApiClientError;
        }
        const statusTypes: Record<number, ApiErrorType> = {
          404: 'NOT_FOUND',
          403: 'FORBIDDEN',
          409: 'CONFLICT',
        };
        throw {
          type:
            statusTypes[response.status] ?? (response.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
          message,
        } satisfies ApiClientError;
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
