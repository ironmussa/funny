import {
  createApiClient,
  createEndpointPolicy,
  validateRemoteOrigin,
  type ApiClientError,
  type ClientCancellation,
} from '@funny/client-core';
import type { DomainError } from '@funny/shared/errors';
import { THREAD_CONTEXT_HEADER } from '@funny/shared/thread-context';
import { ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import { emitUnauthorized } from '@/lib/api/auth-events';
import { createClientLogger } from '@/lib/client-logger';
import { metric, startSpan } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

// ─── Git pull strategy (matches `PullStrategy` in @funny/core/git/remote.ts) ──
export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

const endpointPolicy = createEndpointPolicy(clientComposition.platform.transport.environment);
const log = createClientLogger('api');

export function validateContainerUrl(raw: unknown): string | null {
  return validateRemoteOrigin(raw, endpointPolicy.remoteOriginAllowlist);
}

const apiClient = createApiClient({
  transport: clientComposition.platform.transport,
  endpointPolicy,
  clock: () => performance.now(),
  telemetry: {
    startSpan,
    metric,
    reportFailure: (failure) => {
      log.error('API request failed', { ...failure, online: navigator.onLine });
    },
  },
  circuitBreaker: {
    snapshot: () => useCircuitBreakerStore.getState(),
    recordFailure: () => useCircuitBreakerStore.getState().recordFailure(),
    recordSuccess: () => useCircuitBreakerStore.getState().recordSuccess(),
  },
  onUnauthorized: emitUnauthorized,
  networkFriendlyMessage: () =>
    i18n.t('errors.networkError', {
      defaultValue: 'Unable to reach the server. Check your connection and try again.',
    }),
});

function cancellationFromSignal(
  signal: AbortSignal | null | undefined,
): ClientCancellation | undefined {
  if (!signal) return undefined;
  return {
    get aborted() {
      return signal.aborted;
    },
    subscribe(listener) {
      signal.addEventListener('abort', listener, { once: true });
      return () => signal.removeEventListener('abort', listener);
    },
  };
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function request<T>(path: string, init?: RequestInit): ResultAsync<T, DomainError> {
  const promise = apiClient.request<T>(path, {
    method: init?.method,
    headers: headersFromInit(init?.headers),
    body: typeof init?.body === 'string' ? init.body : undefined,
    cancellation: cancellationFromSignal(init?.signal),
  });
  return ResultAsync.fromPromise(promise, (error) => error as ApiClientError as DomainError);
}

// ─── Thread context ──────────────────────────────────────────────────────────
// The thread whose view is open. Requests about that thread's workspace (files,
// search, skills) carry it so the server runs them where the thread runs — its
// own sandbox, or the machine holding its checkout. Registered by
// `lib/thread-context-source.ts`; null outside a thread.
let threadContextSource: () => string | null = () => null;

export function setThreadContextSource(source: () => string | null): void {
  threadContextSource = source;
}

/** Headers naming the open thread, for a `fetch` made outside `request`. */
export function threadContextHeaders(): Record<string, string> {
  const threadId = threadContextSource();
  return threadId ? { [THREAD_CONTEXT_HEADER]: threadId } : {};
}

/** `request` for the open thread's workspace (see `THREAD_CONTEXT_HEADER`). */
export function requestInThread<T>(path: string, init?: RequestInit): ResultAsync<T, DomainError> {
  const context = threadContextHeaders();
  if (!context[THREAD_CONTEXT_HEADER]) return request<T>(path, init);
  const headers = new Headers(init?.headers);
  headers.set(THREAD_CONTEXT_HEADER, context[THREAD_CONTEXT_HEADER]);
  return request<T>(path, { ...init, headers });
}

/**
 * A URL the browser loads by itself (`<img src>`, iframes), which cannot carry
 * the header: the open thread goes in `?threadId=` instead.
 */
export function urlInThread(url: string): string {
  const threadId = threadContextSource();
  if (!threadId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}threadId=${encodeURIComponent(threadId)}`;
}
